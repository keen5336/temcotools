export const DEFAULT_RELAY_PROGRAM = `function startTemcoSiteRelay(config) {
  // Customize this site's injection here. Keep this call to use the shared
  // pairing, account checks, request limits and disconnect controls.
  startDmpRelay(config);
}`;
