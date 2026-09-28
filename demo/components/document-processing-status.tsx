'use client';

// Keep the status card importable from the course list without duplicating its
// implementation. The dialog owns the visual language for both entry points.
export {
  DocumentProcessingStatus,
  type DocumentProcessing,
} from '@/components/course-import-dialog';
