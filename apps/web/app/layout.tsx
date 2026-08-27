import type { Metadata } from "next";
import "./styles.css";

export const metadata: Metadata = {
  title: "OpenInstinct",
  description: "Your open, iMessage-native personal assistant.",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
