'use client';

import { Button } from './ui/button';

export function CourseSwitcher({
  courses,
  activeId,
  disabled,
  onSelect,
  onCreate,
  onConnect,
}: {
  courses: Array<{ id: string; name: string }>;
  activeId: string | null;
  disabled?: boolean;
  onSelect: (id: string) => void;
  onCreate: () => void;
  onConnect?: () => void;
}) {
  return (
    <nav
      aria-label="课程导航"
      className="mb-5 flex min-w-0 flex-wrap items-center gap-2 md:hidden"
    >
      <label className="flex min-w-0 flex-1 items-center gap-2 text-sm">
        <span className="shrink-0">课程</span>
        <select
          aria-label="切换课程"
          className="min-w-0 flex-1 rounded-lg border bg-white px-2 py-2 focus-visible:outline-2 focus-visible:outline-violet-500"
          value={activeId ?? ''}
          disabled={disabled || !courses.length}
          onChange={(event) => onSelect(event.target.value)}
        >
          {!courses.length && <option value="">暂无课程</option>}
          {courses.map((course) => (
            <option key={course.id} value={course.id}>
              {course.name}
            </option>
          ))}
        </select>
      </label>
      <Button
        size="sm"
        variant="outline"
        disabled={disabled}
        onClick={onCreate}
      >
        创建课程
      </Button>
      {onConnect && (
        <Button
          size="sm"
          variant="outline"
          disabled={disabled}
          onClick={onConnect}
        >
          连接课程
        </Button>
      )}
    </nav>
  );
}
