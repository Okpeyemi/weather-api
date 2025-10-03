'use client';
import { useState } from 'react';
import { useAuth } from '../../hooks/useSupabaseAuth';

export default function Predict() {
  const session = useAuth();
  const [query, setQuery] = useState('');
  const [result, setResult] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!session) return <p>Connecte-toi pour utiliser l'app !</p>;

  const handleSubmit = async (e: { preventDefault: () => void }) => {
    e.preventDefault();
    setLoading(true);
    setError(null);
    setResult('');
    try {
      // Envoie la requête brute au backend (parsing IA + géocodage côté serveur)
      const res = await fetch('/api/predict', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query }),
      });
      const prediction = await res.json();
      if (!res.ok) throw new Error(prediction?.error || 'Erreur API');

      setResult(
        `Prédiction (${prediction.source}) : ${prediction.rainRisk}% de risque de pluie, vent ${prediction.wind}, temp ${prediction.temp}°C`
      );
    } catch (err: any) {
      setError(err?.message || 'Erreur');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div>
      <form onSubmit={handleSubmit}>
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Ex: Vacances à Paris le 10 octobre"
        />
        <button type="submit" disabled={loading}>{loading ? 'Calcul...' : 'Prédire'}</button>
      </form>
      {error && <div style={{ color: 'red' }}>{error}</div>}
      <div>{result}</div>
    </div>
  );
}