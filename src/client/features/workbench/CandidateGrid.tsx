import { useMemo, useState } from "react";
import type { Candidate, ProviderId } from "../../../shared/contracts.js";
import { CandidateCard } from "./CandidateCard.js";

interface CandidateGridProps {
  candidates: Candidate[];
  providerDisplayNames: ReadonlyMap<ProviderId, string>;
  checkedIds: ReadonlySet<string>;
  onToggleChecked: (candidateId: string) => void;
  onSelect: (candidateId: string, shiftKey: boolean) => void;
  onReject: (candidateId: string, shiftKey: boolean) => void;
  onOpen: (candidateId: string) => void;
  onKeepHighestResolution: (groupId: string) => void;
  sensitive: boolean;
  revealedIds: ReadonlySet<string>;
  onSetRevealed: (candidateId: string, revealed: boolean) => void;
}

export function CandidateGrid(props: CandidateGridProps) {
  const { candidates, providerDisplayNames, checkedIds, onToggleChecked, onSelect, onReject, onOpen, onKeepHighestResolution, sensitive, revealedIds, onSetRevealed } = props;
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(() => new Set());
  const groups = useMemo(() => {
    const grouped = new Map<string, Candidate[]>();
    for (const candidate of candidates) {
      if (!candidate.nearDuplicateGroup) continue;
      const current = grouped.get(candidate.nearDuplicateGroup) ?? [];
      current.push(candidate);
      grouped.set(candidate.nearDuplicateGroup, current);
    }
    return grouped;
  }, [candidates]);
  const visible = useMemo(() => candidates.filter((candidate) => {
    const groupId = candidate.nearDuplicateGroup;
    if (!groupId || expandedGroups.has(groupId)) return true;
    return groups.get(groupId)?.[0]?.id === candidate.id;
  }), [candidates, expandedGroups, groups]);

  const toggleGroup = (groupId: string) => setExpandedGroups((prior) => {
    const next = new Set(prior);
    if (next.has(groupId)) next.delete(groupId); else next.add(groupId);
    return next;
  });

  if (!visible.length) return <div className="candidate-grid__empty"><strong>当前筛选下没有素材</strong><span>可以切换分类或放宽筛选条件。</span></div>;

  return (
    <div className="candidate-grid">
      {visible.map((candidate) => {
        const groupId = candidate.nearDuplicateGroup;
        const isGroupRepresentative = Boolean(groupId && groups.get(groupId)?.[0]?.id === candidate.id);
        return <CandidateCard
          key={candidate.id}
          candidate={candidate}
          providerDisplayName={providerDisplayNames.get(candidate.provider) ?? candidate.provider}
          checked={checkedIds.has(candidate.id)}
          duplicateCount={isGroupRepresentative ? groups.get(groupId!)?.length ?? 1 : 1}
          duplicateExpanded={Boolean(groupId && expandedGroups.has(groupId))}
          onToggleChecked={onToggleChecked}
          onSelect={onSelect}
          onReject={onReject}
          onOpen={onOpen}
          onToggleDuplicate={toggleGroup}
          onKeepHighestResolution={onKeepHighestResolution}
          sensitive={sensitive}
          revealed={revealedIds.has(candidate.id)}
          onSetRevealed={onSetRevealed}
        />;
      })}
    </div>
  );
}
