import type { Metadata } from "next";
import "./globals.css";
import Navbar from "@/components/Navbar";

export const metadata: Metadata = {
  title: "OnPeak",
  description: "Predict energy prices. Trade the grid.",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body style={{ background: "#f6f8fa", color: "#1f2328" }}>

        <Navbar />

        {children}
      </body>
    </html>
  );
}