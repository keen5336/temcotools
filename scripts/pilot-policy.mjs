// Shared by the application and existing browser-relay broker. This is an
// environment restriction, never a substitute for individual authorization.
export function pilotPolicy(mode = process.env.TEMCO_PILOT_MODE) {
  if (mode && mode !== "read_only_dmp") throw new Error("Unsupported TEMCO_PILOT_MODE.");
  const isolated = mode === "read_only_dmp";
  return { mode: isolated ? "read_only_dmp" : "standard", isolated, permitsLivePrinting: !isolated, permitsLiveMars: !isolated, permitsDmpMutations: !isolated };
}

export function pilotCapabilityAllowed(capability) {
  return !pilotPolicy().isolated || !["labels.print", "workflow.execute", "office.authorize_rtv"].includes(capability);
}

export function assertPilotReadMethod(method) {
  if (pilotPolicy().isolated && !["GET", "HEAD"].includes(method.toUpperCase())) {
    const error = new Error("This isolated pilot permits named DMP GET/HEAD reads only. Live mutations are disabled.");
    error.status = 403;
    throw error;
  }
}
