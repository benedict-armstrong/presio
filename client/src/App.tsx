import { Suspense, lazy } from "react";
import { BrowserRouter, Routes, Route } from "react-router-dom";
import { ThemeProvider } from "@/lib/theme";
import { AuthProvider } from "@/lib/auth";
import { PasswordRecoveryDialog } from "@/components/PasswordRecoveryDialog";
import Home from "@/pages/Home";
import Presentation from "@/pages/Presentation";
import Present from "@/pages/Present";
import Start from "@/pages/Start";
import Share from "@/pages/Share";

const CheckerPage = lazy(() => import("@/pages/checker/CheckerPage"));

export default function App() {
  return (
    <ThemeProvider>
      <AuthProvider>
        <BrowserRouter>
          <Routes>
            <Route path="/" element={<Home />} />
            <Route path="/present" element={<Present />} />
            <Route path="/start/:id" element={<Start />} />
            <Route path="/s/:id" element={<Presentation />} />
            <Route path="/s/:id/share" element={<Share />} />
            <Route path="/check" element={<Suspense fallback={null}><CheckerPage /></Suspense>} />
          </Routes>
          <PasswordRecoveryDialog />
        </BrowserRouter>
      </AuthProvider>
    </ThemeProvider>
  );
}
