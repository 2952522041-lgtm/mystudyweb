import { renderToStaticMarkup } from 'react-dom/server';
import { SummaryDiffView } from '../components/summary-diff-view.tsx';

export interface DiffViewFixtureProps {
  before: string;
  after: string;
  beforeLabel?: string;
  afterLabel?: string;
}

/** Server-render the component so a plain Node test can inspect the markup. */
export function renderDiffView(props: DiffViewFixtureProps): string {
  return renderToStaticMarkup(<SummaryDiffView {...props} />);
}
