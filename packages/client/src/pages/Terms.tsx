import { LegalLayout, LegalSection } from '@/components/LegalLayout';
import { DEV_INFO } from '@/config/dev';

export function TermsPage() {
  return (
    <LegalLayout title="Terms of Service" updated="October 2026">
      <p className="text-[0.95rem] leading-relaxed text-[var(--color-ink-soft)]">
        By using Beam you agree to these terms. Beam is a free tool for transferring files directly
        between devices. Please use it responsibly.
      </p>

      <LegalSection title="The service">
        <p>
          Beam helps a sender and one or more receivers establish an end-to-end encrypted connection
          to transfer files — directly between devices where possible, or through an encrypted relay
          when networks block a direct path. The sender must keep the page open for the transfer to
          happen — unless you choose to keep an encrypted copy, which the server holds for up to 24
          hours. Beam cannot decrypt copies, and cannot recover or resend files once a transfer or copy
          is gone.
        </p>
      </LegalSection>

      <LegalSection title="Acceptable use">
        <p>
          You are solely responsible for the files you transfer and for ensuring you have the right
          to share them. Do not use Beam to transfer unlawful material or to infringe anyone's
          rights. Do not attempt to disrupt, overload, or abuse the signaling or relay service; we
          may rate-limit or block traffic that does. You are responsible for who you give a share
          link or short code to — anyone holding it can receive the files. Encrypted copies are
          limited in size and number, and may be removed early if storage runs low or they are used
          to abuse the service.
        </p>
      </LegalSection>

      <LegalSection title="No warranty">
        <p>
          Beam is provided “as is”, without warranties of any kind. Peer-to-peer connections depend
          on both networks and may not always succeed. We do not guarantee availability, delivery,
          speed, or uninterrupted operation.
        </p>
      </LegalSection>

      <LegalSection title="Limitation of liability">
        <p>
          To the maximum extent permitted by law, the developer is not liable for any loss or damage
          arising from your use of Beam, including failed transfers, lost data, or interrupted
          connections.
        </p>
      </LegalSection>

      <LegalSection title="Changes & contact">
        <p>
          These terms may be updated over time; continued use means you accept the current version.
          Questions? Reach the developer via{' '}
          <a
            href={DEV_INFO.portfolioUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="link-ul text-[var(--color-ink)]"
          >
            {DEV_INFO.portfolioUrl.replace(/^https?:\/\//, '')}
          </a>
          .
        </p>
      </LegalSection>
    </LegalLayout>
  );
}
