import { Sidebar } from '@/components/layout/sidebar';
import { Header } from '@/components/layout/header';
import { GlobalCommandPalette } from '@/components/layout/global-command-palette';
import { OnboardingTrigger } from '@/components/onboarding/onboarding-trigger';

// Authenticated app chrome — sidebar, header, command palette, the
// onboarding trigger. Unauth surfaces (under (auth)/) opt out of this
// layout by living in their own route group.
export default function AppLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <div className="flex h-screen overflow-hidden">
        <Sidebar />
        <div className="flex flex-1 flex-col overflow-hidden">
          <Header />
          <main className="flex-1 overflow-y-auto">{children}</main>
        </div>
      </div>
      <GlobalCommandPalette />
      <OnboardingTrigger />
    </>
  );
}
