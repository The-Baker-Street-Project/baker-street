import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { AuthProvider, useAuth } from './hooks/useAuth';
import { ErrorBoundary } from './components/ErrorBoundary';
import { Layout } from './components/Layout';
import { ChatPage } from './pages/ChatPage';
import { JobsPage } from './pages/JobsPage';
import { ConversationsPage } from './pages/ConversationsPage';
import { MemoryPage } from './pages/MemoryPage';
import { SecretsPage } from './pages/SecretsPage';
import { SkillsPage } from './pages/SkillsPage';
import { ExtensionsPage } from './pages/ExtensionsPage';
import { ModelsPage } from './pages/ModelsPage';
import { SystemPage } from './pages/SystemPage';
import { SchedulesPage } from './pages/SchedulesPage';
import { LoginPage } from './pages/LoginPage';
import type { ReactNode } from 'react';

function ProtectedRoute({ children }: { children: ReactNode }) {
  const { isAuthenticated } = useAuth();
  if (!isAuthenticated) {
    return <Navigate to="/login" replace />;
  }
  return <>{children}</>;
}

function AppRoutes() {
  const { isAuthenticated } = useAuth();

  return (
    <Routes>
      <Route
        path="/login"
        element={isAuthenticated ? <Navigate to="/chat" replace /> : <LoginPage />}
      />
      <Route
        element={
          <ProtectedRoute>
            <Layout />
          </ProtectedRoute>
        }
      >
        <Route path="/chat/:id?" element={<ChatPage />} />
        <Route path="/jobs/:id?" element={<JobsPage />} />
        <Route path="/schedules" element={<SchedulesPage />} />
        <Route path="/conversations" element={<ConversationsPage />} />
        <Route path="/conversations/:id" element={<ConversationsPage />} />
        <Route path="/memory" element={<MemoryPage />} />
        <Route path="/secrets" element={<SecretsPage />} />
        <Route path="/extensions" element={<ExtensionsPage />} />
        <Route path="/skills" element={<Navigate to="/extensions" replace />} />
        <Route path="/models" element={<ModelsPage />} />
        <Route path="/system" element={<SystemPage />} />
      </Route>
      <Route path="*" element={<Navigate to="/chat" replace />} />
    </Routes>
  );
}

export function App() {
  return (
    <BrowserRouter>
      <AuthProvider>
        <ErrorBoundary>
          <AppRoutes />
        </ErrorBoundary>
      </AuthProvider>
    </BrowserRouter>
  );
}
