export function slug(title) {
  return title.toLowerCase().replace(/[^a-z0-9]/g, "-");
}
