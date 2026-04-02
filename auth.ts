import NextAuth from "next-auth";
import MicrosoftEntraID from "next-auth/providers/microsoft-entra-id";
import { prisma } from "@/lib/db";

export const { handlers, signIn, signOut, auth } = NextAuth({
  providers: [
    MicrosoftEntraID({
      clientId: process.env.AZURE_AD_CLIENT_ID!,
      clientSecret: process.env.AZURE_AD_CLIENT_SECRET!,
      issuer: `https://login.microsoftonline.com/${process.env.AZURE_AD_TENANT_ID}/v2.0`,
    }),
  ],
  callbacks: {
    async signIn({ user, account, profile }) {
      if (!profile?.email) return false;

      const oid =
        ((profile as Record<string, unknown>).oid as string) ||
        ((profile as Record<string, unknown>).sub as string);
      if (!oid) return false;

      const email = profile.email as string;
      const name = (profile.name as string) || (user.name as string) || email;
      const firstAdminEmail = process.env.FIRST_ADMIN_EMAIL;

      let dbUser = await prisma.user.findUnique({ where: { microsoftOid: oid } });

      if (!dbUser) {
        dbUser = await prisma.user.create({
          data: {
            email,
            name,
            microsoftOid: oid,
            role: firstAdminEmail && email === firstAdminEmail ? "admin" : "user",
            isActive: true,
          },
        });
      } else {
        await prisma.user.update({
          where: { id: dbUser.id },
          data: { lastLoginAt: new Date() },
        });
      }

      if (!dbUser.isActive) return false;
      return true;
    },
    async jwt({ token, profile }) {
      if (profile) {
        const oid =
          ((profile as Record<string, unknown>).oid as string) ||
          ((profile as Record<string, unknown>).sub as string);
        if (oid) {
          const dbUser = await prisma.user.findUnique({ where: { microsoftOid: oid } });
          if (dbUser) {
            token.userId = dbUser.id;
            token.role = dbUser.role;
            token.isActive = dbUser.isActive;
          }
        }
      }
      return token;
    },
    async session({ session, token }) {
      if (token) {
        session.user.id = token.userId as string;
        session.user.role = token.role as string;
        session.user.isActive = token.isActive as boolean;
      }
      return session;
    },
  },
  pages: {
    signIn: "/signin",
  },
  session: {
    strategy: "jwt",
  },
});
