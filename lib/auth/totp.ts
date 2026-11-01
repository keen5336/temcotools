import { verify } from "otplib";
import { IdentityError } from "./passwords";

export async function verifyTotpStep(secret: string, token: string, lastUsedStep: number, now = Date.now()): Promise<number> {
  const invalid = () => new IdentityError("Authenticator or recovery code is invalid or already used. Wait for the next authenticator code if necessary.", 401);
  if (!/^\d{6}$/.test(token)) throw invalid();
  try {
    const result = await verify({ strategy: "totp", secret, token, digits: 6, algorithm: "sha1", period: 30,
      epoch: Math.floor(now / 1000), epochTolerance: [30, 0], ...(lastUsedStep < 0 ? {} : { afterTimeStep: lastUsedStep }),
    });
    if (!result.valid || !("timeStep" in result)) throw invalid();
    return result.timeStep;
  } catch { throw invalid(); }
}
