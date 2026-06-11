import type { TabGroup } from '../core/types'

export const GROUP_COLOR_VALUES: Record<string, string> = {
  grey: '#5f6368',
  blue: '#1a73e8',
  red: '#d93025',
  yellow: '#f9ab00',
  green: '#188038',
  pink: '#d01884',
  purple: '#a142f4',
  cyan: '#007b83',
  orange: '#fa903e',
}

export interface GroupHeaderProps {
  group: TabGroup
  onToggleCollapsed: (groupId: string) => void
}

/** The colored group chip shown before a group's tabs, like Chrome's. */
export function GroupHeader({ group, onToggleCollapsed }: GroupHeaderProps) {
  const color = GROUP_COLOR_VALUES[group.visualData.color] ?? GROUP_COLOR_VALUES['grey']!
  return (
    <button
      type="button"
      className={[
        'ctabs-group-header',
        group.visualData.isCollapsed && 'ctabs-group-header--collapsed',
      ]
        .filter(Boolean)
        .join(' ')}
      style={{ ['--ctabs-group-color' as string]: color }}
      onClick={() => onToggleCollapsed(group.id)}
      title={group.visualData.isCollapsed ? 'Expand group' : 'Collapse group'}
    >
      {group.visualData.title || ' '}
    </button>
  )
}
