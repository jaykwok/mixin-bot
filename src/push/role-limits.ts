// What one push settings save may carry. The service checks a save against these (./service.ts parseRoles); the console
// sizes its request limit for the save by them (console/server/push-routes.ts). A small module: the console imports it
// without the service.
export const ROLE_LIMITS = {
  /** People on the list. */
  people: 1000,
  /** Departments granted to one person. */
  departments: 200,
  /** The highest cap on pushes within 24 hours. */
  dailyLimit: 1000,
} as const;
