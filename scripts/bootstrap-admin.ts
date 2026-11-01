/** Compatibility entry point. No default account, environment password or PIN bootstrap. */
import { runBootstrapCli } from "./v2-bootstrap";
import { maintenanceFailure } from "./v2-preflight-support";

runBootstrapCli().catch(maintenanceFailure);
