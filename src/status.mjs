// Status-name helpers shared by the config validator and the model, kept apart so the model needs no file access.
export const STATUS_GROUPS = ["done", "inReview", "inProgress", "todo"];

/** Status option names are compared after trimming and lower-casing, so "In Progress" and "In progress" match. */
export function normStatus(name) {
  return typeof name === "string" ? name.trim().toLowerCase() : "";
}
