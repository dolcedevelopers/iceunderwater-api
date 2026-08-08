import {
  assertOwnsRecord,
  resolveSupplierScope,
  type SessionLike,
} from "../authz/permissions.js";
import { accessDenied, validationError } from "../lib/errors.js";
import { centsToRands, randsToCents } from "../lib/money.js";
import type { ProductDto } from "../serializers/dto.js";
import { writeAudit } from "../repositories/auditRepo.js";
import {
  findProductOwner,
  listProductsFromWp,
  softDeleteProductOwner,
  upsertProductOwner,
} from "../repositories/productRepo.js";
import { createWcProduct, deleteWcProduct, listWcCategories, updateWcProduct } from "../clients/woocommerce.js";
import { uploadImageBuffer } from "./mediaService.js";
import { execute, query } from "../db/pool.js";
import type { RowDataPacket } from "mysql2";

function mapProduct(row: {
  id: number;
  supplier_id: string;
  name: string;
  category: string;
  price_cents: number;
  stock: number;
  description: string;
  image: string;
  active: number;
  unit: string;
}): ProductDto {
  return {
    id: String(row.id),
    supplierId: row.supplier_id,
    name: row.name,
    category: row.category || "",
    price: centsToRands(Number(row.price_cents) || 0),
    stock: Number(row.stock) || 0,
    unit: row.unit || "",
    description: stripHtml(row.description || ""),
    image: row.image || "",
    active: Boolean(row.active),
  };
}

function stripHtml(value: string): string {
  return value.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

async function resolveCategoryId(raw: string): Promise<number | undefined> {
  const alias = raw.trim();
  if (!alias) return undefined;
  const normalized = alias.toLowerCase();
  const mapped = await query<(RowDataPacket & { wc_term_id: number | null; approved: number })[]>(
    `SELECT wc_term_id, approved FROM iuw_category_map WHERE alias_normalized = :n LIMIT 1`,
    { n: normalized },
  );
  if (mapped[0]?.approved && mapped[0].wc_term_id) return mapped[0].wc_term_id;

  const cats = await listWcCategories();
  const exact = cats.find((c) => c.name.toLowerCase() === normalized);
  if (exact) {
    await execute(
      `INSERT INTO iuw_category_map (alias, alias_normalized, wc_term_id, approved)
       VALUES (:alias, :normalized, :termId, 1)
       ON DUPLICATE KEY UPDATE wc_term_id = VALUES(wc_term_id), approved = 1`,
      { alias, normalized, termId: exact.id },
    );
    return exact.id;
  }

  const pending = cats.find((c) => c.name.toLowerCase() === "pending category") || cats.find((c) => c.name === "Uncategorized");
  await execute(
    `INSERT INTO iuw_category_map (alias, alias_normalized, wc_term_id, approved)
     VALUES (:alias, :normalized, :termId, 0)
     ON DUPLICATE KEY UPDATE alias = VALUES(alias)`,
    { alias, normalized, termId: pending?.id ?? null },
  );
  return pending?.id;
}

export async function listPublicProducts() {
  const rows = await listProductsFromWp({ publicOnly: true });
  return rows.map(mapProduct);
}

export async function getPublicProduct(id: string) {
  const rows = await listProductsFromWp({ publicOnly: true, productId: Number(id) });
  return rows[0] ? mapProduct(rows[0]) : null;
}

export async function listCatalogueCategories() {
  const cats = await listWcCategories();
  return cats
    .filter((c) => c.name !== "Uncategorized")
    .map((c) => ({ id: String(c.id), name: c.name, image: c.image?.src || "", count: c.count }));
}

export async function listManagedProducts(session: SessionLike, supplierId?: string) {
  const scope = resolveSupplierScope(session, supplierId);
  const rows = await listProductsFromWp({ supplierId: scope });
  return rows.map(mapProduct);
}

export async function createProductFor(
  session: SessionLike,
  supplierId: string | undefined,
  data: {
    name: string;
    category?: string;
    price: number;
    stock?: number;
    unit?: string;
    description?: string;
    active?: boolean;
  },
  ip?: string,
) {
  const scope = resolveSupplierScope(session, supplierId);
  if (!scope) throw accessDenied("Choose which supplier this product belongs to.");
  if (!data.name?.trim()) throw validationError("Product name is required.");

  const categoryId = await resolveCategoryId(data.category || "");
  const priceCents = randsToCents(Number(data.price) || 0);
  const wc = await createWcProduct({
    name: data.name.trim(),
    regular_price: (priceCents / 100).toFixed(2),
    description: data.description || "",
    short_description: data.description || "",
    stock_quantity: Number(data.stock) || 0,
    status: data.active === false ? "draft" : "publish",
    categories: categoryId ? [{ id: categoryId }] : undefined,
    meta_data: [
      { key: "_iuw_supplier_id", value: scope },
      { key: "_iuw_unit", value: data.unit || "" },
    ],
  });
  await upsertProductOwner(wc.id, scope);
  const product = (await listProductsFromWp({ productId: wc.id }))[0];
  const dto = product ? mapProduct(product) : {
    id: String(wc.id),
    supplierId: scope,
    name: wc.name,
    category: data.category || "",
    price: centsToRands(priceCents),
    stock: Number(data.stock) || 0,
    unit: data.unit || "",
    description: data.description || "",
    image: "",
    active: data.active !== false,
  };
  await writeAudit({ session, action: "product.create", targetType: "product", targetId: String(wc.id), ip, after: dto });
  return dto;
}

export async function updateProductFor(
  session: SessionLike,
  productId: string,
  changes: Record<string, unknown>,
  ip?: string,
) {
  const owner = await findProductOwner(Number(productId));
  assertOwnsRecord(session, owner ? { supplierId: owner.supplier_id } : null, "product");

  const patch: Parameters<typeof updateWcProduct>[1] = {};
  if (typeof changes.name === "string") patch.name = changes.name;
  if (typeof changes.description === "string") {
    patch.description = changes.description;
    patch.short_description = changes.description;
  }
  if (typeof changes.price === "number") {
    patch.regular_price = (randsToCents(changes.price) / 100).toFixed(2);
  }
  if (typeof changes.stock === "number") patch.stock_quantity = changes.stock;
  if (typeof changes.active === "boolean") patch.status = changes.active ? "publish" : "draft";
  if (typeof changes.category === "string") {
    const categoryId = await resolveCategoryId(changes.category);
    if (categoryId) patch.categories = [{ id: categoryId }];
  }
  const meta: { key: string; value: string }[] = [];
  if (typeof changes.unit === "string") meta.push({ key: "_iuw_unit", value: changes.unit });
  if (meta.length) patch.meta_data = meta;

  await updateWcProduct(Number(productId), patch);
  const row = (await listProductsFromWp({ productId: Number(productId) }))[0];
  const dto = row ? mapProduct(row) : null;
  await writeAudit({
    session,
    action: "product.update",
    targetType: "product",
    targetId: productId,
    ip,
    after: dto,
  });
  return dto;
}

export async function deleteProductFor(session: SessionLike, productId: string, ip?: string) {
  const owner = await findProductOwner(Number(productId));
  assertOwnsRecord(session, owner ? { supplierId: owner.supplier_id } : null, "product");
  await deleteWcProduct(Number(productId));
  await softDeleteProductOwner(Number(productId));
  await writeAudit({ session, action: "product.delete", targetType: "product", targetId: productId, ip });
  return { id: productId };
}

export async function uploadProductImage(
  session: SessionLike,
  productId: string,
  buffer: Buffer,
  filename: string,
  ip?: string,
) {
  const owner = await findProductOwner(Number(productId));
  assertOwnsRecord(session, owner ? { supplierId: owner.supplier_id } : null, "product");
  const { url, mediaId } = await uploadImageBuffer(buffer, filename);
  await updateWcProduct(Number(productId), { images: [{ id: mediaId }] });
  return updateProductFor(session, productId, {}, ip).then((p) => p || { id: productId, image: url });
}
