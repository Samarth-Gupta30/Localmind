import { SearchResult } from '../services/vectorStore.service';

/**
 * Merges multiple ranked result lists into a single unified ranking using Reciprocal Rank Fusion.
 *
 * Formula: RRF_Score(d) = SUM( 1 / (k + rank_position) )
 *
 * @param queryResults Array of candidate result lists (e.g., [BM25Hits, VectorHits])
 * @param k Scaling parameter (default: 60)
 * @returns Unified, deduplicated array of SearchResult sorted by descending RRF score
 */
export function reciprocalRankFusion(
  queryResults: SearchResult[][],
  k = 60
): SearchResult[] {
  const scoreMap = new Map<
    string,
    { result: SearchResult; rrfScore: number }
  >();

  for (const resultsList of queryResults) {
    resultsList.forEach((item, rank) => {
      const docId = item.chunk.id;
      // rank is 0-indexed, so (rank + 1) provides the 1-based rank position
      const rankScore = 1 / (k + rank + 1);

      const existing = scoreMap.get(docId);

      if (existing) {
        existing.rrfScore += rankScore;
      } else {
        scoreMap.set(docId, {
          result: item,
          rrfScore: rankScore,
        });
      }
    });
  }

  return Array.from(scoreMap.values())
    .sort((a, b) => b.rrfScore - a.rrfScore)
    .map(({ result, rrfScore }) => ({
      ...result,
      score: rrfScore, // Attaches aggregated RRF score to result object
    }));
}