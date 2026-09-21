export interface User {
  id: string;
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  /** ISO date. Shown on the profile page as "Member since". */
  memberSince: string;
}

export interface Credentials {
  email: string;
  password: string;
}

export interface RegisterInput extends Credentials {
  firstName: string;
  lastName: string;
}

export interface AuthSession {
  user: User;
  /** Opaque today; a real JWT once an auth backend exists. */
  token: string;
}
