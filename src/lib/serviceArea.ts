import { validationError } from "./errors.js";

export type RequestLocation = {
  address: string;
  latitude: number;
  longitude: number;
  fulfilmentType: "delivery" | "pickup";
};

export function requestLocation(value: unknown): RequestLocation {
  const location = value as Partial<RequestLocation> | null;
  if (!location || typeof location.address !== "string" || !location.address.trim()
    || location.address.trim().length > 512
    || typeof location.latitude !== "number" || !Number.isFinite(location.latitude) || Math.abs(location.latitude) > 90
    || typeof location.longitude !== "number" || !Number.isFinite(location.longitude) || Math.abs(location.longitude) > 180
    || !["delivery", "pickup"].includes(location.fulfilmentType || "")) {
    throw validationError("Confirm the delivery or pickup address and its location on the map.");
  }
  return { address: location.address.trim(), latitude: location.latitude, longitude: location.longitude,
    fulfilmentType: location.fulfilmentType as RequestLocation["fulfilmentType"] };
}

export function distanceKm(first: { latitude: number; longitude: number }, second: { latitude: number; longitude: number }): number {
  const radians = (degrees: number) => degrees * Math.PI / 180;
  const latitude = radians(second.latitude - first.latitude);
  const longitude = radians(second.longitude - first.longitude);
  const a = Math.sin(latitude / 2) ** 2
    + Math.cos(radians(first.latitude)) * Math.cos(radians(second.latitude)) * Math.sin(longitude / 2) ** 2;
  return 6371.0088 * 2 * Math.atan2(Math.sqrt(Math.min(1, a)), Math.sqrt(Math.max(0, 1 - a)));
}

export function supplierServesLocation(supplier: { latitude?: unknown; longitude?: unknown; service_radius_km?: unknown }, location: RequestLocation): boolean {
  if (supplier.latitude == null || supplier.longitude == null || supplier.service_radius_km == null) return false;
  const latitude = Number(supplier.latitude);
  const longitude = Number(supplier.longitude);
  const radius = Number(supplier.service_radius_km);
  if (!Number.isFinite(latitude) || Math.abs(latitude) > 90 || !Number.isFinite(longitude)
    || Math.abs(longitude) > 180 || !Number.isFinite(radius) || radius <= 0) return false;
  return distanceKm({ latitude, longitude }, location) <= radius;
}
