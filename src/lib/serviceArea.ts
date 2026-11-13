import { findCity } from "../data/saLocations.js";
import { validationError } from "./errors.js";

export type RequestLocation = { address: string; province: string; city: string; fulfilmentType: "delivery" | "pickup" };
const aliases: Record<string, string> = { "port elizabeth": "Gqeberha", "nelspruit": "Mbombela", "witbank": "eMalahleni" };
export function selectedCity(province: unknown, city: unknown) {
  if (typeof province !== "string" || typeof city !== "string") throw validationError("Select a province and a city.");
  const found = findCity(city);
  if (!found || found.province.toLowerCase() !== province.trim().toLowerCase()) throw validationError("Select a city in the chosen province.");
  return { province: found.province, city: aliases[found.city.toLowerCase()] || found.city };
}
export function requestLocation(value: unknown): RequestLocation {
  const location = value as Partial<RequestLocation> | null;
  if (!location || !["delivery", "pickup"].includes(location.fulfilmentType || "")) throw validationError("Choose delivery or collection.");
  const place = selectedCity(location.province, location.city);
  const address = typeof location.address === "string" ? location.address.trim() : "";
  if (address.length > 512 || (location.fulfilmentType === "delivery" && !address)) throw validationError("Enter your delivery street address.");
  return { ...place, address: address || `${place.city}, ${place.province}`, fulfilmentType: location.fulfilmentType as RequestLocation["fulfilmentType"] };
}
export function supplierServesLocation(supplier: { city?: unknown; province?: unknown }, location: RequestLocation): boolean {
  if (typeof supplier.city !== "string") return false;
  const known = findCity(supplier.city);
  if (!known) return false;
  try {
    const place = selectedCity(supplier.province || known.province, supplier.city);
    return place.province === location.province && place.city === location.city;
  } catch { return false; }
}
