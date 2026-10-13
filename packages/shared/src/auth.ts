import { z } from "zod";

const password = z.string().min(8).max(200);

/** The first password, with the code the server writes to its log. */
export const authSetupSchema = z.object({ password, code: z.string().trim().min(1).max(20) }).strict();
export const authLoginSchema = z.object({ password: z.string().min(1).max(200) }).strict();
export const authPasswordSchema = z.object({ current: z.string().min(1).max(200), next: password }).strict();

/** "token": the desktop window; "password": the server in a browser. */
export interface AuthState {
  mode: "token" | "password";
  passwordSet: boolean;
  signedIn: boolean;
}
