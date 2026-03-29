export interface User {
  id: string;
  name: string;
  email: string;
  role: UserRole;
}

export enum UserRole {
  ADMIN = "admin",
  USER = "user",
  GUEST = "guest",
}

export type AuthToken = string;

export interface Config {
  port: number;
  dbUrl: string;
}
