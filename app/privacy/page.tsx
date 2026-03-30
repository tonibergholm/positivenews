import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "Privacy Policy — PositiveNews",
  description: "How PositiveNews handles your data.",
};

export default function PrivacyPage() {
  return (
    <article className="prose prose-warm mx-auto max-w-2xl py-8">
      <h1 className="font-heading">Privacy Policy</h1>
      <p className="text-sm text-muted-foreground">Last updated: 30 March 2026</p>

      <h2>What is PositiveNews?</h2>
      <p>
        PositiveNews is a news aggregator that curates positive, constructive journalism
        from publicly available RSS feeds. The service is operated as a personal project
        at <strong>bergholm.net/news</strong>.
      </p>

      <h2>Data we collect</h2>
      <p>
        We are committed to minimal data collection. Here is everything we process:
      </p>

      <h3>Browser storage (your device only)</h3>
      <ul>
        <li>
          <strong>Theme preference</strong> — Your light/dark mode choice is saved in
          your browser&apos;s localStorage. This data never leaves your device.
        </li>
        <li>
          <strong>Read articles</strong> — Article IDs you have clicked are stored in
          localStorage to show which articles you have already read. This data never
          leaves your device. A maximum of 500 entries are kept.
        </li>
      </ul>

      <h3>Flagging articles</h3>
      <p>
        When you flag an article as &quot;not positive news,&quot; we process your request
        on the server. To prevent abuse, your IP address is temporarily held in memory for
        rate limiting (max 10 flags per minute). <strong>IP addresses are not stored in any
        database or log file</strong> and are discarded when the server restarts.
      </p>
      <p>
        Keywords extracted from flagged article titles are stored in our database to improve
        content filtering. These keywords are aggregate data and are not linked to any user
        or IP address.
      </p>

      <h3>What we do NOT collect</h3>
      <ul>
        <li>No cookies</li>
        <li>No analytics or tracking scripts</li>
        <li>No personal information (name, email, account)</li>
        <li>No cross-site tracking</li>
        <li>No advertising</li>
        <li>No data sharing with third parties</li>
      </ul>

      <h2>Server logs</h2>
      <p>
        Our web server (nginx) may log IP addresses and request URLs in standard access
        logs. These logs are used solely for security monitoring and are rotated
        automatically. They are not used for analytics or user profiling.
      </p>

      <h2>External links</h2>
      <p>
        PositiveNews links to external news articles. When you click a link, you leave our
        site and are subject to the privacy policy of the destination site. We set{" "}
        <code>rel=&quot;noopener noreferrer&quot;</code> on all external links to limit
        referrer information shared with third-party sites.
      </p>

      <h2>Data retention</h2>
      <ul>
        <li>
          <strong>Browser data:</strong> Stored until you clear your browser data.
        </li>
        <li>
          <strong>Rate limit data:</strong> In-memory only, cleared on server restart.
        </li>
        <li>
          <strong>Learned keywords:</strong> Retained indefinitely to improve content
          filtering.
        </li>
        <li>
          <strong>Server logs:</strong> Rotated per standard nginx configuration.
        </li>
      </ul>

      <h2>Your rights under GDPR</h2>
      <p>
        Since we do not collect personal data beyond temporary IP processing for rate
        limiting, most GDPR rights (access, rectification, erasure, portability) have
        limited applicability. However, you have the right to:
      </p>
      <ul>
        <li>
          <strong>Clear your local data</strong> at any time by clearing your browser&apos;s
          localStorage for this site.
        </li>
        <li>
          <strong>Contact us</strong> with any privacy-related questions or concerns.
        </li>
      </ul>

      <h2>Security</h2>
      <p>
        The site is served over HTTPS with strict transport security. Content Security
        Policy headers restrict resource loading. See our{" "}
        <Link href="/terms">Terms of Service</Link> for more details.
      </p>

      <h2>Changes to this policy</h2>
      <p>
        If we make material changes to this policy, we will update the &quot;Last
        updated&quot; date at the top of this page.
      </p>

      <h2>Contact</h2>
      <p>
        For privacy-related inquiries, please reach out via the contact information
        available at <strong>bergholm.net</strong>.
      </p>
    </article>
  );
}
