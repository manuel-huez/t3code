import * as Effect from "effect/Effect";
import * as Path from "effect/Path";

import { expandHomePath } from "@t3tools/provider-core/server/pathExpansion";
import * as HostProcess from "@t3tools/shared/HostProcess";

/** Grok's state folder: `GROK_HOME`, else `.grok` in the environment's user home. */
export const resolveGrokHome = Effect.fn("resolveGrokHome")(function* (
  environment: NodeJS.ProcessEnv,
) {
  const path = yield* Path.Path;
  const userHome =
    environment.HOME || environment.USERPROFILE || (yield* HostProcess.HomeDirectory);
  const configured = environment.GROK_HOME?.trim();
  return path.resolve(
    configured ? expandHomePath(configured, userHome) : path.join(userHome, ".grok"),
  );
});
