import { expect, it } from "vitest";
import { distanceKm, requestLocation, supplierServesLocation } from "../src/lib/serviceArea.js";
const point = { address: "Business", latitude: 0, longitude: 0, fulfilmentType: "delivery" as const };
it("measures distance and includes the radius boundary", () => {
  const next = { ...point, latitude: 1 };
  const distance = distanceKm(point, next);
  expect(distance).toBeCloseTo(111.195, 2);
  expect(supplierServesLocation({ latitude: 0, longitude: 0, service_radius_km: distance }, next)).toBe(true);
  expect(supplierServesLocation({ latitude: 0, longitude: 0, service_radius_km: distance - 0.01 }, next)).toBe(false);
});
it("requires confirmed coordinates and a positive supplier radius", () => {
  for (const supplier of [{}, { latitude: 0, longitude: 0 }, { latitude: 0, longitude: 0, service_radius_km: 0 }, { latitude: 91, longitude: 0, service_radius_km: 5 }]) expect(supplierServesLocation(supplier, point)).toBe(false);
  for (const invalid of [null, { ...point, latitude: null }, { ...point, longitude: Infinity }, { ...point, address: " " }, { ...point, fulfilmentType: "other" }]) expect(() => requestLocation(invalid)).toThrow();
  expect(requestLocation({ ...point, fulfilmentType: "pickup" }).fulfilmentType).toBe("pickup");
});
