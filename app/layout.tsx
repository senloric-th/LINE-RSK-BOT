import type { ReactNode } from "react";

export const metadata = {
  title: "LINE RSK Bot",
  description: "Webhook service for ร้านรักสุขภาพ LINE bot",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="th">
      <body>{children}</body>
    </html>
  );
}
