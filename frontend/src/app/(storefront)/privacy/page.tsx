import type { Metadata } from "next";
import Link from "next/link";

import { ContentPage } from "@/components/layout/ContentPage";
import { getSiteConfig } from "@/services/siteService";

export const metadata: Metadata = {
  title: "Privacy policy",
  description:
    "What data Daily Choice Zone collects, why, how long it is kept and the choices you have over it.",
  alternates: { canonical: "/privacy" },
};

export default async function PrivacyPage() {
  const config = await getSiteConfig();

  return (
    <ContentPage
      title="Privacy policy"
      intro="What we collect, why we collect it, and what you can do about it."
      updated="29 September 2026"
    >
      <section>
        <h2>The short version</h2>
        <p>
          We run no analytics, no advertising and no third-party trackers. What you save — your
          account, your bag, your addresses, your orders — is kept securely by us.
        </p>
        <p>
          Your device remembers that you&rsquo;re signed in, along with a bag and wishlist held for you
          before you sign in, a checkout you are part-way through and the products you recently
          viewed. Clearing your browser data removes these and leaves your account untouched.
        </p>
        <p>
          Payments are processed by Razorpay. Your card, UPI and bank details are entered on
          Razorpay&rsquo;s own secure systems and never reach us.
        </p>
      </section>

      <section>
        <h2>What we collect</h2>
        <ul>
          <li>
            <strong>Order information</strong> — your name, delivery address, email and phone
            number. We need these to deliver a parcel and to tell you where it is.
          </li>
          <li>
            <strong>Account information</strong> — your name and email if you create an account,
            plus any addresses you choose to save.
          </li>
          <li>
            <strong>Payment information</strong> — handled entirely by our payment provider,
            Razorpay. Card numbers, UPI PINs and bank log-ins never reach us. We keep
            only what Razorpay tells us about the result: the payment reference, the amount, the
            method used (for example &ldquo;UPI&rdquo; or &ldquo;card&rdquo;) and whether it
            succeeded or was refunded.
          </li>
          <li>
            <strong>Browsing information</strong> — your bag, wishlist and recently viewed items,
            kept on your device so the store remembers them between visits.
          </li>
        </ul>
      </section>

      <section>
        <h2>What we do not do</h2>
        <ul>
          <li>We do not sell or rent your personal information to anyone.</li>
          <li>We do not buy data about you from third parties to enrich your profile.</li>
          <li>
            We do not email you marketing unless you asked for it, and every such email has a
            one-click unsubscribe.
          </li>
        </ul>
      </section>

      <section>
        <h2>Who we share it with</h2>
        <p>
          Only the parties needed to complete your order: the courier that carries the parcel, and
          Razorpay, which processes the payment and receives your name, email, phone number and
          the amount due. Each receives the minimum required — the courier gets an address, not
          your order history. Razorpay&rsquo;s handling of your data is governed by its own
          privacy policy.
        </p>
      </section>

      <section>
        <h2>How long we keep it</h2>
        <p>
          Order records are kept for eight years, which Indian tax and accounting rules require.
          Account details are kept until you ask us to delete the account. Marketing consent is
          kept until you withdraw it.
        </p>
      </section>

      <section>
        <h2>Your choices</h2>
        <p>
          You can ask for a copy of what we hold, ask us to correct it, or ask us to delete it —
          except where we are legally required to keep order records. Write to{" "}
          <a href={`mailto:${config.support.email}`}>{config.support.email}</a> and we will respond
          within 30 days.
        </p>
        <p>
          You can clear everything this site has stored on your device at any time from{" "}
          <Link href="/account/settings">account settings</Link>.
        </p>
      </section>

      <section id="cookies" className="scroll-mt-28">
        <h2>Cookie policy</h2>
        <p>
          We don&rsquo;t set cookies of our own. Your sign-in, bag, wishlist and preferences are
          remembered on your device so the store works smoothly between visits, and no other
          website can read them. When you pay, Razorpay&rsquo;s secure payment window may set its
          own cookies to keep the payment safe.
        </p>
        <p>If we introduce cookies, they will fall into three groups:</p>
        <ul>
          <li>
            <strong>Essential</strong> — keeping you signed in and your bag intact. These cannot be
            switched off without breaking the store.
          </li>
          <li>
            <strong>Analytics</strong> — understanding which pages people struggle with. Optional,
            and off until you agree.
          </li>
          <li>
            <strong>Marketing</strong> — measuring whether an advert led to a purchase. Optional,
            and off until you agree.
          </li>
        </ul>
        <p>
          You will be asked once, the choice will be remembered, and declining will never degrade
          the store beyond losing the optional feature itself.
        </p>
      </section>

      <section>
        <h2>Contact</h2>
        <p>
          Questions about any of this go to{" "}
          <a href={`mailto:${config.support.email}`}>{config.support.email}</a>, or{" "}
          {config.support.phone} during {config.support.hours}.
        </p>
      </section>
    </ContentPage>
  );
}
