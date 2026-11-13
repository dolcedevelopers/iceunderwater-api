import { expect, it } from "vitest";
import { requestLocation, supplierServesLocation } from "../src/lib/serviceArea.js";
const location = { address: "Street address", province: "Gauteng", city: "Johannesburg", fulfilmentType: "delivery" as const };
it("matches only the selected city and province without a radius or coordinates", () => {
  expect(supplierServesLocation({city:"Johannesburg",province:"Gauteng"},location)).toBe(true);
  expect(supplierServesLocation({city:"Pretoria",province:"Gauteng"},location)).toBe(false);
  expect(supplierServesLocation({city:"Johannesburg",province:"Western Cape"},location)).toBe(false);
  expect(supplierServesLocation({city:"Johannesburg"},location)).toBe(true);
  expect(supplierServesLocation({},location)).toBe(false);
});
it("validates province/city combinations and handles old city names", () => {
  for (const invalid of [null, {...location,province:"Western Cape"}, {...location,city:"Unknown"}, {...location,address:""}, {...location,fulfilmentType:"other"}]) expect(()=>requestLocation(invalid)).toThrow();
  expect(requestLocation({...location,city:"johannesburg",province:"gauteng"}).city).toBe("Johannesburg");
  const eastern = requestLocation({...location,province:"Eastern Cape",city:"Gqeberha"});
  expect(supplierServesLocation({province:"Eastern Cape",city:"Port Elizabeth"},eastern)).toBe(true);
  expect(requestLocation({...location,address:"",fulfilmentType:"pickup"}).address).toBe("Johannesburg, Gauteng");
});
