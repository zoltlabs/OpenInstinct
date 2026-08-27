import { z } from "zod";

export const oauthTokenSetSchema = z.object({
  accessToken: z.string().min(1),
  refreshToken: z.string().min(1).optional(),
  expiresAt: z.string().datetime(),
  scope: z.string().optional(),
  tokenType: z.string().default("Bearer"),
});

export type OAuthTokenSet = z.infer<typeof oauthTokenSetSchema>;

export interface ConnectorToolDescriptor {
  readonly name: string;
  readonly description: string;
  readonly risk:
    | "read"
    | "write"
    | "communicate"
    | "financial"
    | "destructive"
    | "security";
}
