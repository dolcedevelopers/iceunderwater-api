import { beforeEach, expect, it, vi } from "vitest";
import { listPublicProducts, getPublicProduct, listManagedProducts } from "../src/services/productService.js";
import { listProductsFromWp, listProductMedia } from "../src/repositories/productRepo.js";
vi.mock("../src/repositories/productRepo.js", async (original) => ({ ...await original<object>(), listProductsFromWp: vi.fn(), listProductMedia: vi.fn(async()=>[]) }));
beforeEach(() => {
  vi.mocked(listProductsFromWp).mockResolvedValue([
    { id: 50, supplier_id: "", name: "WordPress item", price_cents: 23995, cost_cents: 20000, markup_percent: 20,
      active: 1, stock: 0, in_stock: 1, has_options: 0, image: "http://iceunderwater.co.za/wp-content/uploads/original.jpg", category: "Water", description: "<p>Clear water</p>" },
    { id: 51, supplier_id: "a", name: "Mobile item", price_cents: 1404, cost_cents: 1300, markup_percent: 8,
      active: 1, stock: 0, in_stock: 0, has_options: 1, image: "", category: "Water", description: "" },
  ] as never);
});
it("formats both product sources consistently without exposing supplier costs publicly", async () => {
  const rows = await listPublicProducts();
  expect(rows[0]).toMatchObject({ price: 239.95, supplierId: "", inStock: true, hasOptions: false,
    image: "https://iceunderwater.co.za/wp-content/uploads/original.jpg", description: "Clear water" });
  expect(rows[1]).toMatchObject({ price: 14.04, supplierId: "a", inStock: false, hasOptions: true });
  for (const row of rows) { expect(row).not.toHaveProperty("costPrice"); expect(row).not.toHaveProperty("markupPercent"); }
});
it("does not expose costs through individual public product URLs", async () => {
  expect(await getPublicProduct("50")).not.toHaveProperty("costPrice");
});
it("keeps cost and markup available in the authenticated supplier's own catalogue", async () => {
  const result = await listManagedProducts({ sub: 1, wpUserId: 1, role: "supplier", supplierId: "a", email: "a@example.com" });
  expect(listProductsFromWp).toHaveBeenCalledWith({ supplierId: "a" });
  expect(result[0]).toHaveProperty("costPrice", 200);
});

it("scopes catalogue queries by authenticated buying tier", async () => {
  await listPublicProducts();
  expect(listProductsFromWp).toHaveBeenLastCalledWith({publicOnly:true,businessType:undefined});
  const company={sub:1,wpUserId:1,role:"company" as const,email:"buyer@example.com",businessStatus:"active" as const,supplierId:"b"};
  await listPublicProducts(company);
  expect(listProductsFromWp).toHaveBeenLastCalledWith({publicOnly:true,businessType:"supplier"});
  await getPublicProduct("50",company);
  expect(listProductsFromWp).toHaveBeenLastCalledWith({publicOnly:true,productId:50,businessType:"supplier"});
  await expect(listPublicProducts({...company,businessStatus:"pending"})).rejects.toThrow();
  await expect(listPublicProducts({...company,role:"supplier"})).rejects.toThrow();
});

it("returns at most five pictures from WordPress gallery data",async()=>{
 vi.mocked(listProductsFromWp).mockResolvedValue([{id:77,supplier_id:"a",name:"Water",price_cents:500,cost_cents:300,markup_percent:10,active:1,stock:10,image:"https://iceunderwater.co.za/wp-content/uploads/1.jpg",thumbnail_id:1,gallery_ids:"2,3,4,5,6,7",category:"Water",description:"",unit:"500 ml"}] as never);
 vi.mocked(listProductMedia).mockImplementation(async ids=>ids.map(id=>({id,src:`https://iceunderwater.co.za/wp-content/uploads/${id}.jpg`})));
 const products=await listPublicProducts();expect(products[0]!.images?.map(p=>p.id)).toEqual([1,2,3,4,5]);expect(products[0]).not.toHaveProperty("costPrice");
});
