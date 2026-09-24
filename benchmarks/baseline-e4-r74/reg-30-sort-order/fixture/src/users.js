export function sortUsers(users) {
  return users.sort((a, b) => (a.name < b.name ? -1 : 1)).reverse();
}
