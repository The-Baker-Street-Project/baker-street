import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../hooks/useAuth';
import { useAgentName } from '../hooks/useAgentName';

export function LoginPage() {
  const [tokenInput, setTokenInput] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const { login } = useAuth();
  const navigate = useNavigate();
  const agentName = useAgentName();

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError('');
    setLoading(true);

    const trimmed = tokenInput.trim();
    if (!trimmed) {
      setError('Token is required');
      setLoading(false);
      return;
    }

    const success = await login(trimmed);
    setLoading(false);

    if (success) {
      navigate('/chat', { replace: true });
    } else {
      setError('Invalid token');
    }
  }

  return (
    <div className="flex items-center justify-center min-h-screen bg-gray-950">
      <div className="w-full max-w-sm p-8 bg-gray-900 rounded-xl border border-gray-800">
        <h1 className="text-xl font-semibold text-white mb-2">{agentName}</h1>
        <p className="text-sm text-gray-400 mb-6">Enter your authentication token to continue.</p>

        <form onSubmit={handleSubmit}>
          <label htmlFor="token" className="block text-sm font-medium text-gray-300 mb-2">
            Auth Token
          </label>
          <input
            id="token"
            type="password"
            value={tokenInput}
            onChange={(e) => setTokenInput(e.target.value)}
            placeholder="Paste your AUTH_TOKEN here"
            className="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded-lg text-white placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
            autoFocus
          />

          {error && (
            <p className="mt-2 text-sm text-red-400">{error}</p>
          )}

          <button
            type="submit"
            disabled={loading}
            className="w-full mt-4 px-4 py-2 bg-blue-600 hover:bg-blue-500 disabled:bg-gray-700 disabled:text-gray-500 text-white font-medium rounded-lg transition-colors"
          >
            {loading ? 'Verifying...' : 'Sign In'}
          </button>
        </form>
      </div>
    </div>
  );
}
