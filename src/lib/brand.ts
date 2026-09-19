/**
 * Client-safe Fortune & Automations brand tokens.
 * NEVER put Master location IDs, live location IDs, pipeline IDs, tokens,
 * or secrets in this module — it is imported by client components.
 */

export const BRAND = {
  name: "Fortune & Automations",
  product: "Fortune & Automations Business Dashboard",
  legal: "Fortune & Finance LLC",
  website: "https://www.fortuneandautomations.com",
  appHost: "app.fortuneandautomations.com",
  linksHost: "links.fortuneandautomations.com",
  timezone: "US/Eastern",
  representative: "George Nassar",
  tagline: "AUTOMATION • WEBSITES • BRANDING • SYSTEMS",
  voice: "Make Your Business Look Better. Work Smarter. Run Smoother.",
  supportEmailRecovered: "Automations@fortuneandfinance.com",
  supportPhoneRecovered: "860-337-2617",
  colors: {
    // Locked app-dashboard palette (2026-09-17 design pass). Distinct from the
    // marketing-site navy/gold tokens — do not merge the two systems.
    blue: "#445367",
    blueDark: "#314258",
    gold: "#BCA077",
    cream: "#F3EFE9",
    white: "#FFFFFF",
  },
  /** Display label only — not a CRM pipeline UUID. */
  pipelineName: "Fortune & Automations Sales Pipeline",
  dashboards: {
    owner: "F&A | OWNER COMMAND CENTER",
    sales: "F&A | SALES & LEAD PERFORMANCE",
  },
  clientForbiddenTerms: [
    "HighLevel",
    "GoHighLevel",
    "GHL",
    "LeadConnector",
    "app.gohighlevel.com",
  ],
} as const;

export const SERVICES = ["Automation", "Websites", "Branding", "Systems"] as const;
