/**
 * Cloudflare Durable Object regional placement hints.
 *
 * Each entry maps a stable region id (used as the DO name) to the
 * locationHint we pass on creation. CF places the DO somewhere within
 * the hinted region for its lifetime. Listing all of them here so the
 * Worker can fan out to every region in one parallel call.
 *
 * Region codes per https://developers.cloudflare.com/durable-objects/reference/data-location/
 */
export const REGIONS = [
    { id: "wnam", label: "Western North America", hint: "wnam" as const },
    { id: "enam", label: "Eastern North America", hint: "enam" as const },
    { id: "sam", label: "South America", hint: "sam" as const },
    { id: "weur", label: "Western Europe", hint: "weur" as const },
    { id: "eeur", label: "Eastern Europe", hint: "eeur" as const },
    { id: "apac", label: "Asia Pacific", hint: "apac" as const },
    { id: "oc", label: "Oceania", hint: "oc" as const },
    { id: "me", label: "Middle East", hint: "me" as const },
    { id: "afr", label: "Africa", hint: "afr" as const },
] as const;

export type RegionId = (typeof REGIONS)[number]["id"];
export type LocationHint = (typeof REGIONS)[number]["hint"];

export function locationHintFor(regionId: string): LocationHint | undefined {
    const found = REGIONS.find(r => r.id === regionId);
    return found?.hint;
}
