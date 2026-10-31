import { LegalLayout, LegalSection } from '@/components/LegalLayout';
import { DEV_INFO } from '@/config/dev';

export function PrivacyPage() {
  return (
    <LegalLayout title="Privacy Policy" updated="October 2026">
      <p className="text-[0.95rem] leading-relaxed text-[var(--color-ink-soft)]">
        Beam is built to collect as little as technically possible. There are no accounts, no
        tracking, and your files are never uploaded to us. This policy explains the few things the
        service does touch.
      </p>

      <LegalSection title="We can't read your files">
        <p>
          Files are encrypted in your browser and sent directly to the recipient over an encrypted
          peer-to-peer (WebRTC) connection. File names and sizes are encrypted too. The key lives
          only in the share link's URL fragment, which browsers never transmit to a server.
        </p>
        <p>
          When two networks won't allow a direct connection, the already-encrypted stream is passed
          through our server so the transfer can still happen. We can't decrypt it, and nothing is
          stored — the data only passes through on its way to the recipient.
        </p>
      </LegalSection>

      <LegalSection title="Optional encrypted copies">
        <p>
          If you choose “Keep an encrypted copy”, your browser uploads the encrypted chunks and the
          encrypted file list to our server so people can download after you close the tab. We store
          only that ciphertext — we can’t decrypt it — together with its size, an upload token, the
          time it expires and the uploading IP address (used for abuse limits). Copies are deleted
          automatically after 24 hours, or when you press “Delete copy”.
        </p>
      </LegalSection>

      <LegalSection title="Short codes">
        <p>
          When you use a short code like 42-tiger-ocean, the server only learns its number, which it
          uses to find your transfer. The words are checked directly between the two browsers with a
          password-authenticated key exchange, so they never reach us.
        </p>
      </LegalSection>

      <LegalSection title="What the signaling server handles">
        <p>
          To introduce two devices, our signaling server temporarily holds an ephemeral “room”
          identifier and basic presence state in memory, which expires automatically. It
          does not store file contents, keys, or persistent personal data.
        </p>
        <p>
          As with any internet service, connection metadata such as IP addresses is processed
          transiently to establish the connection (this is inherent to how WebRTC and web servers
          work). If a TURN relay is configured for difficult networks, it relays already-encrypted
          data without the ability to read it.
        </p>
      </LegalSection>

      <LegalSection title="Storage on your own device">
        <p>
          Received files are written straight to the location you choose on your device. Only in
          browsers that can't stream downloads (such as some private windows) are files held in the
          browser's local storage until you save them. Either way the data stays on your device.
        </p>
        <p>
          If you install Beam and share files to it from another app, those files are parked in the
          browser's local storage only until the send page picks them up, then deleted.
        </p>
      </LegalSection>

      <LegalSection title="Who can receive your files">
        <p>
          Anyone who has the share link can receive the files while your tab is open — several
          people can use the same link. Share it only with the people you intend, and close the tab
          to stop sharing. Links stop working once you close the tab or the room expires.
        </p>
      </LegalSection>

      <LegalSection title="No cookies, no analytics, no ads">
        <p>
          Beam does not use advertising, third-party analytics, or tracking cookies. There is nothing
          to profile and nothing to sell.
        </p>
      </LegalSection>

      <LegalSection title="Contact">
        <p>
          Questions about privacy? Reach the developer via{' '}
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
