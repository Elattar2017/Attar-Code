export interface User {
  id: string;
  name: string;
  email: string;
}
export enum UserRole { ADMIN = "admin", USER = "user" }
