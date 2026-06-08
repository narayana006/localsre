---
name: paper-review
description: Write and review academic / IEEE-style papers — structure, formatting, citations, clarity, reproducibility, peer-review checklist.
---
# Academic / IEEE paper writing & review

Use `read_document` to ingest a draft (PDF/DOCX), then audit or co-write. For LaTeX/PDF output use the office-docs skill (pandoc / LaTeX).

## IEEE paper structure (verify each is present and sound)
1. Title + Abstract (150–250 words: problem, approach, key result, contribution)
2. Introduction (motivation, the gap, contributions as a bullet list, paper roadmap)
3. Related Work (positions vs prior art; cites seminal + recent; states the delta clearly)
4. Method / Approach (precise and reproducible; notation defined; algorithms/figures)
5. Experiments (datasets, baselines, metrics, setup, hyperparameters, hardware)
6. Results (tables/plots WITH error bars; ablations; honest limitations)
7. Conclusion (restate contribution + future work) + References (consistent style)

## Peer-review checklist (flag by severity)
- Claims vs evidence: is every abstract/intro claim actually supported by the results? (overclaiming = High)
- Reproducibility: enough detail (data, code, seeds, hyperparameters) to reproduce? Missing = High.
- Baselines: fair, current, correctly tuned? Any cherry-picking?
- Statistics: error bars / significance / multiple runs? Single-run claims are weak.
- Novelty: is the delta over prior art clear and honest? Missing citations?
- Figures/tables: captioned, referenced in text, readable, axis labels + units?
- Clarity: undefined notation, acronyms expanded on first use, consistent terminology.
- Formatting: IEEE template (IEEEtran), 2-column, citation style, page limit.
- Ethics/limitations: a limitations section and threats-to-validity present?

## IEEE formatting / build
- LaTeX: `\documentclass[conference]{IEEEtran}`; BibTeX with `IEEEtran.bst`.
- Build: `latexmk -pdf paper.tex` (or `pdflatex → bibtex → pdflatex ×2`). Install: `brew install --cask mactex` (or `basictex`).

Output a prioritized findings list (Critical/High/Medium/Low) with the exact section, the issue, and a concrete fix — the rigor of a real reviewer.
