/** Admin = email in the ADMIN_EMAILS allowlist (comma separated). Unset or empty means NOBODY is admin. */
export function isAdmin(email: string | null | undefined, list: string | undefined = process.env.ADMIN_EMAILS): boolean {
  if (!email || !list) return false;
  const allowed = list.split(",").map((e) => e.trim().toLowerCase()).filter(Boolean);
  return allowed.includes(email.trim().toLowerCase());
}
