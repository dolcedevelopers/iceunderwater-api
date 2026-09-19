/** Fixed South Africa city → province map for register dropdowns and company filters. */

export type SaCity = { city: string; province: string };

export const SA_CITIES: SaCity[] = [
  { city: "Johannesburg", province: "Gauteng" },
  { city: "Pretoria", province: "Gauteng" },
  { city: "Sandton", province: "Gauteng" },
  { city: "Centurion", province: "Gauteng" },
  { city: "Midrand", province: "Gauteng" },
  { city: "Randburg", province: "Gauteng" },
  { city: "Roodepoort", province: "Gauteng" },
  { city: "Soweto", province: "Gauteng" },
  { city: "Benoni", province: "Gauteng" },
  { city: "Boksburg", province: "Gauteng" },
  { city: "Germiston", province: "Gauteng" },
  { city: "Kempton Park", province: "Gauteng" },
  { city: "Alberton", province: "Gauteng" },
  { city: "Vanderbijlpark", province: "Gauteng" },
  { city: "Vereeniging", province: "Gauteng" },
  { city: "Cape Town", province: "Western Cape" },
  { city: "Stellenbosch", province: "Western Cape" },
  { city: "Paarl", province: "Western Cape" },
  { city: "Somerset West", province: "Western Cape" },
  { city: "George", province: "Western Cape" },
  { city: "Knysna", province: "Western Cape" },
  { city: "Worcester", province: "Western Cape" },
  { city: "Durban", province: "KwaZulu-Natal" },
  { city: "Pietermaritzburg", province: "KwaZulu-Natal" },
  { city: "Umhlanga", province: "KwaZulu-Natal" },
  { city: "Ballito", province: "KwaZulu-Natal" },
  { city: "Richards Bay", province: "KwaZulu-Natal" },
  { city: "Port Elizabeth", province: "Eastern Cape" },
  { city: "Gqeberha", province: "Eastern Cape" },
  { city: "East London", province: "Eastern Cape" },
  { city: "Mthatha", province: "Eastern Cape" },
  { city: "Bloemfontein", province: "Free State" },
  { city: "Welkom", province: "Free State" },
  { city: "Nelspruit", province: "Mpumalanga" },
  { city: "Mbombela", province: "Mpumalanga" },
  { city: "Witbank", province: "Mpumalanga" },
  { city: "eMalahleni", province: "Mpumalanga" },
  { city: "Polokwane", province: "Limpopo" },
  { city: "Tzaneen", province: "Limpopo" },
  { city: "Rustenburg", province: "North West" },
  { city: "Potchefstroom", province: "North West" },
  { city: "Mahikeng", province: "North West" },
  { city: "Kimberley", province: "Northern Cape" },
  { city: "Upington", province: "Northern Cape" },
];

const byCity = new Map(SA_CITIES.map((row) => [row.city.toLowerCase(), row]));

export function listProvinces(): string[] {
  return [...new Set(SA_CITIES.map((row) => row.province))].sort((a, b) => a.localeCompare(b));
}

export function findCity(city: string | undefined | null): SaCity | null {
  const key = String(city || "").trim().toLowerCase();
  if (!key) return null;
  return byCity.get(key) || null;
}

export function provinceForCity(city: string | undefined | null): string {
  return findCity(city)?.province || "";
}

/** Validate optional city; empty allowed. Throws message string if invalid when provided. */
export function assertKnownCity(city: string | undefined | null): SaCity | null {
  const trimmed = String(city || "").trim();
  if (!trimmed) return null;
  const found = findCity(trimmed);
  if (!found) throw new Error("Choose a city from the list.");
  return found;
}

export function locationsPayload() {
  return {
    cities: SA_CITIES.map((row) => ({ city: row.city, province: row.province })),
    provinces: listProvinces(),
  };
}
