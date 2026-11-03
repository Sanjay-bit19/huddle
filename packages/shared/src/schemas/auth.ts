import { z } from 'zod';

export const emailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .pipe(z.email({ message: 'Enter a valid email address' }))
  .refine((v) => v.length <= 254, 'Email is too long');

// Length-only policy (NIST 800-63B): long passphrases beat composition rules.
// The 128 cap bounds argon2 work per request.
export const passwordSchema = z
  .string()
  .min(8, 'Password must be at least 8 characters')
  .max(128, 'Password must be at most 128 characters');

export const signupSchema = z.object({
  email: emailSchema,
  name: z.string().trim().min(1, 'Name is required').max(80),
  password: passwordSchema,
});
export type SignupInput = z.infer<typeof signupSchema>;

export const loginSchema = z.object({
  email: emailSchema,
  password: z.string().min(1).max(128),
});
export type LoginInput = z.infer<typeof loginSchema>;

export const publicUserSchema = z.object({
  id: z.uuid(),
  email: z.string(),
  name: z.string(),
});
export type PublicUser = z.infer<typeof publicUserSchema>;

export const authResponseSchema = z.object({
  accessToken: z.string(),
  expiresIn: z.number().int(),
  user: publicUserSchema,
});
export type AuthResponse = z.infer<typeof authResponseSchema>;

/** Claims carried by the JWT access token. Shared by the API and the collab server. */
export const accessTokenClaimsSchema = z.object({
  sub: z.uuid(),
  name: z.string(),
  /** Session (refresh-token family) id. Revoking the session kills the access token too. */
  sid: z.uuid(),
});
export type AccessTokenClaims = z.infer<typeof accessTokenClaimsSchema>;

export const ACCESS_TOKEN_ISSUER = 'huddle';
export const ACCESS_TOKEN_AUDIENCE = 'huddle';
