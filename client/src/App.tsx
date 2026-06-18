import { Suspense, lazy } from "react";
import { BrowserRouter, Routes, Route } from "react-router-dom";
import { ThemeProvider } from "@/lib/theme";
import { AuthProvider } from "@/lib/auth";
import Home from "@/pages/Home";
import Presentation from "@/pages/Presentation";
import Share from "@/pages/Share";

// Lazy: the About page pulls in Shiki (grammars + wasm), so keep it out of the
// initial bundle and load it only when someone visits /about.
const About = lazy(() => import("@/pages/About"));

export default function App() {
  return (
    <ThemeProvider>
      <AuthProvider>
        <BrowserRouter>
          <Routes>
            <Route path="/" element={<Home />} />
            <Route path="/s/:id" element={<Presentation />} />
            <Route path="/s/:id/share" element={<Share />} />
            <Route path="/about" element={<Suspense fallback={null}><About /></Suspense>} />
          </Routes>
        </BrowserRouter>
      </AuthProvider>
    </ThemeProvider>
  );
}
