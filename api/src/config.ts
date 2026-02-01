import 'dotenv/config';

export const config = {
  port: Number(process.env.PORT ?? 3000),
  jwtSecret: process.env.JWT_SECRET ?? 'dev-jwt-secret-change-me',
  adminEmail: process.env.ADMIN_EMAIL ?? 'admin@local',
  adminPassword: process.env.ADMIN_PASSWORD ?? 'admin-change-me',

  cookieName: process.env.COOKIE_NAME ?? 'mvbar_token',
  cookieSecure: (process.env.COOKIE_SECURE ?? 'auto') as 'auto' | 'true' | 'false',
  trustProxy: (process.env.TRUST_PROXY ?? 'false') as 'true' | 'false'
};
