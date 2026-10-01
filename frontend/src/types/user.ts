export interface User {
  id: string;
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  /** ISO date. Shown on the profile page as "Member since". */
  memberSince: string;
  /** Whether the email address has been confirmed with the emailed link. */
  emailVerified?: boolean;
}

export interface Credentials {
  email: string;
  password: string;
}

export interface RegisterInput extends Credentials {
  firstName: string;
  lastName: string;
  /** A friend's referral code. Checked by the server; an invalid one is refused. */
  referralCode?: string;
}

export interface AuthSession {
  user: User;
  /** Opaque today; a real JWT once an auth backend exists. */
  token: string;
}
