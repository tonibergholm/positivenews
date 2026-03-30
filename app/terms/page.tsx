import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "Terms of Service — PositiveNews",
  description: "Terms of service for using PositiveNews.",
};

export default function TermsPage() {
  return (
    <article className="prose prose-warm mx-auto max-w-2xl py-8">
      <h1 className="font-heading">Terms of Service</h1>
      <p className="text-sm text-muted-foreground">Last updated: 30 March 2026</p>

      <h2>About the service</h2>
      <p>
        PositiveNews (&quot;the Service&quot;) is a personal, non-commercial news
        aggregator that curates positive and constructive journalism from publicly
        available RSS feeds. The Service is provided as-is at{" "}
        <strong>bergholm.net/news</strong>.
      </p>

      <h2>Use of the service</h2>
      <p>
        The Service is free to use. By accessing it, you agree to these terms. You may
        browse articles, use the category filters, toggle dark mode, and flag articles
        you believe are not positive news.
      </p>

      <h2>Content</h2>
      <p>
        PositiveNews aggregates and links to content published by third-party news
        sources. We do not create, edit, or endorse the content of linked articles.
        All intellectual property rights for article content, titles, and images belong
        to their respective publishers.
      </p>
      <p>
        We display article titles, summaries, and thumbnail images under fair use for
        the purpose of news aggregation and linking. If you are a content owner and wish
        to have your content removed, please contact us.
      </p>

      <h2>User conduct</h2>
      <p>You agree not to:</p>
      <ul>
        <li>Abuse the flagging system (rate limiting is enforced)</li>
        <li>Attempt to disrupt the Service through automated requests or attacks</li>
        <li>Scrape or systematically download content from the Service</li>
        <li>Use the Service for any unlawful purpose</li>
      </ul>

      <h2>Content filtering</h2>
      <p>
        PositiveNews uses automated keyword-based filtering and user feedback to
        determine which articles appear. This process is imperfect — some negative
        articles may slip through, and some positive articles may be incorrectly
        filtered out. We make no guarantee about the accuracy of our classification.
      </p>

      <h2>Availability</h2>
      <p>
        The Service is provided on a best-effort basis. We do not guarantee uptime,
        availability, or uninterrupted access. The Service may be modified, suspended,
        or discontinued at any time without notice.
      </p>

      <h2>Limitation of liability</h2>
      <p>
        The Service is provided &quot;as is&quot; without warranties of any kind,
        express or implied. We are not liable for any damages arising from your use of
        the Service, including but not limited to the accuracy or completeness of
        aggregated content.
      </p>

      <h2>External links</h2>
      <p>
        All article links lead to third-party websites. We are not responsible for the
        content, privacy practices, or availability of these external sites. See our{" "}
        <Link href="/privacy">Privacy Policy</Link> for how we handle referrer
        information.
      </p>

      <h2>Changes to these terms</h2>
      <p>
        We may update these terms at any time. Continued use of the Service after
        changes constitutes acceptance of the updated terms.
      </p>

      <h2>Governing law</h2>
      <p>
        These terms are governed by the laws of Finland. Any disputes shall be resolved
        in a Finnish court of competent jurisdiction.
      </p>

      <h2>Contact</h2>
      <p>
        For questions about these terms, please reach out via the contact information
        available at <strong>bergholm.net</strong>.
      </p>
    </article>
  );
}
