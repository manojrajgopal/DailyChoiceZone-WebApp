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
  /**
   * Whether `phone` is a sign-in number confirmed with a code. Only ever set
   * from what the server says — a number typed on the profile is a contact
   * number until it is confirmed.
   */
  phoneVerified?: boolean;
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
  /** Ticked "send me offers" — marketing email consent. Off unless ticked. */
  marketingOptIn?: boolean;
  /** A mobile number, offered when the store signs in with SMS codes. */
  phone?: string;
}

export interface AuthSession {
  user: User;
  /** Opaque today; a real JWT once an auth backend exists. */
  token: string;
}
