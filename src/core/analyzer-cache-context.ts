/**
 * @license
 * Copyright (c) 2016 The Polymer Project Authors. All rights reserved.
 * This code may only be used under the BSD style license found at
 * http://polymer.github.io/LICENSE.txt
 * The complete set of authors may be found at
 * http://polymer.github.io/AUTHORS.txt
 * The complete set of contributors may be found at
 * http://polymer.github.io/CONTRIBUTORS.txt
 * Code distributed by Google as part of the polymer project is also
 * subject to an additional IP rights grant found at
 * http://polymer.github.io/PATENTS.txt
 */

import * as path from 'path';

import {LazyEdgeMap, NoKnownParserError, Options, ScannerTable} from '../analyzer';
import {CssParser} from '../css/css-parser';
import {HtmlCustomElementReferenceScanner} from '../html/html-element-reference-scanner';
import {HtmlImportScanner} from '../html/html-import-scanner';
import {HtmlParser} from '../html/html-parser';
import {HtmlScriptScanner} from '../html/html-script-scanner';
import {HtmlStyleScanner} from '../html/html-style-scanner';
import {JavaScriptParser} from '../javascript/javascript-parser';
import {JsonParser} from '../json/json-parser';
import {Document, InlineDocInfo, LocationOffset, Package, ScannedDocument, ScannedElement, ScannedFeature, ScannedImport, ScannedInlineDocument} from '../model/model';
import {ParsedDocument} from '../parser/document';
import {Parser} from '../parser/parser';
import {Measurement, TelemetryTracker} from '../perf/telemetry';
import {BehaviorScanner} from '../polymer/behavior-scanner';
import {CssImportScanner} from '../polymer/css-import-scanner';
import {DomModuleScanner} from '../polymer/dom-module-scanner';
import {PolymerElementScanner} from '../polymer/polymer-element-scanner';
import {PseudoElementScanner} from '../polymer/pseudo-element-scanner';
import {scan} from '../scanning/scan';
import {Scanner} from '../scanning/scanner';
import {UrlLoader} from '../url-loader/url-loader';
import {UrlResolver} from '../url-loader/url-resolver';
import {ElementScanner as VanillaElementScanner} from '../vanilla-custom-elements/element-scanner';
import {Severity, Warning, WarningCarryingException} from '../warning/warning';

import {AnalysisCache} from './analysis-cache';

/**
 * Represents an Analyzer with a given AnalysisCache instance.
 *
 * Used to provide a consistent cache in the face of updates happening in
 * parallel with analysis work. A given AnalyzerCacheContext is forked via
 * either the fileChanged or clearCaches methods.
 *
 * For almost all purposes this is an entirely internal implementation detail.
 */
export class AnalyzerCacheContext {
  private _parsers = new Map<string, Parser<ParsedDocument<any, any>>>([
    ['html', new HtmlParser()],
    ['js', new JavaScriptParser({sourceType: 'script'})],
    ['css', new CssParser()],
    ['json', new JsonParser()],
  ]);

  /** A map from import url to urls that document lazily depends on. */
  private _lazyEdges: LazyEdgeMap|undefined;

  private _scanners: ScannerTable;

  private _loader: UrlLoader;
  private _resolver: UrlResolver|undefined;

  private _cache = new AnalysisCache();

  private _telemetryTracker = new TelemetryTracker();
  private _generation = 0;

  private static _getDefaultScanners(lazyEdges: LazyEdgeMap|undefined) {
    return new Map<string, Scanner<any, any, any>[]>([
      [
        'html',
        [
          new HtmlImportScanner(lazyEdges),
          new HtmlScriptScanner(),
          new HtmlStyleScanner(),
          new DomModuleScanner(),
          new CssImportScanner(),
          new HtmlCustomElementReferenceScanner(),
          new PseudoElementScanner()
        ]
      ],
      [
        'js',
        [
          new PolymerElementScanner(),
          new BehaviorScanner(),
          new VanillaElementScanner()
        ]
      ],
    ]);
  }

  constructor(options: Options) {
    this._loader = options.urlLoader;
    this._resolver = options.urlResolver;
    this._parsers = options.parsers || this._parsers;
    this._lazyEdges = options.lazyEdges;
    this._scanners = options.scanners ||
        AnalyzerCacheContext._getDefaultScanners(this._lazyEdges);
  }

  /**
   * Returns a copy of this cache context with proper cache invalidation.
   */
  filesChanged(urls: string[]) {
    const newCache =
        this._cache.invalidate(urls.map(url => this._resolveUrl(url)));
    return this._fork(newCache);
  }

  /**
   * Implements Analyzer#analyze, see its docs.
   */
  async analyze(url: string, contents?: string): Promise<Document> {
    const resolvedUrl = this._resolveUrl(url);
    return this._cache.analyzedDocumentPromises.getOrCompute(
        resolvedUrl, async() => {
          const doneTiming =
              this._telemetryTracker.start('analyze: make document', url);
          const scannedDocument = await this._scan(resolvedUrl, contents);
          const document = this._getDocument(scannedDocument.url, resolvedUrl);
          doneTiming();
          return document;
        });
  }

  private async _analyzeOrWarning(url: string): Promise<Document|Warning> {
    try {
      return await this.analyze(url);
    } catch (e) {
      if (e instanceof WarningCarryingException) {
        return e.warning;
      }
      return {
        sourceRange: {
          file: this._resolveUrl(url),
          start: {line: 0, column: 0},
          end: {line: 0, column: 0}
        },
        code: 'unable-to-analyze',
        message: `Unable to analyze file: ${e && e.message || e}`,
        severity: Severity.ERROR
      };
    }
  }

  async analyzePackage(): Promise<Package> {
    if (!this._loader.readDirectory) {
      throw new Error(
          `This analyzer doesn't support analyzerPackage, ` +
          `the urlLoader can't list the files in a directory.`);
    }
    const allFiles = await this._loader.readDirectory('', true);
    // TODO(rictic): parameterize this, perhaps with polymer.json.
    const dependencyDirPrefixes: string[] =
        ['bower_components', 'node_modules'];
    const filesInPackage = allFiles.filter(file => {
      const dirname = path.dirname(file);
      return !dependencyDirPrefixes.some(prefix => dirname.startsWith(prefix));
    });

    const extensions = new Set(this._parsers.keys());
    const filesWithParsers = filesInPackage.filter(
        fn => extensions.has(path.extname(fn).substring(1)));
    const documentsOrWarnings =
        await Promise.all(filesWithParsers.map(f => this._analyzeOrWarning(f)));
    const documents = [];
    const warnings = [];
    for (const docOrWarning of documentsOrWarnings) {
      if (docOrWarning instanceof Document) {
        documents.push(docOrWarning);
      } else {
        warnings.push(docOrWarning);
      }
    }
    return new Package(documents, warnings);
  }

  /**
   * Gets an analyzed Document from the document cache. This is only useful for
   * Analyzer plugins. You almost certainly want to use `analyze()` instead.
   *
   * If a document has been analyzed, it returns the analyzed Document. If not
   * the scanned document cache is used and a new analyzed Document is returned.
   * If a file is in neither cache, it returns `undefined`.
   */
  _getDocument(url: string, _requester?: string): Document|undefined {
    const resolvedUrl = this._resolveUrl(url);
    const cachedResult = this._cache.analyzedDocuments.get(resolvedUrl);
    if (cachedResult) {
      return cachedResult;
    }
    const scannedDocument = this._cache.scannedDocuments.get(resolvedUrl);
    if (!scannedDocument) {
      return;
    }

    const document = new Document(scannedDocument, this);
    document['_context'] = this;
    this._cache.analyzedDocuments.set(resolvedUrl, document);
    this._cache.analyzedDocumentPromises.getOrCompute(
        resolvedUrl, async() => document);

    document.resolve();
    return document;
  }

  /**
   * This is only useful for Analyzer plugins.
   *
   * If a url has been scanned, returns the ScannedDocument.
   */
  _getScannedDocument(url: string): ScannedDocument|undefined {
    const resolvedUrl = this._resolveUrl(url);
    return this._cache.scannedDocuments.get(resolvedUrl);
  }

  async getTelemetryMeasurements(): Promise<Measurement[]> {
    return this._telemetryTracker.getMeasurements();
  }

  /**
   * Clear all cached information from this analyzer instance.
   *
   * Note: if at all possible, instead tell the analyzer about the specific
   * files that changed rather than clearing caches like this. Caching provides
   * large performance gains.
   */
  clearCaches(): AnalyzerCacheContext {
    return this._fork(new AnalysisCache());
  }

  /**
   * Return a copy, but with the given cache.
   */
  private _fork(cache: AnalysisCache): AnalyzerCacheContext {
    const copy = new AnalyzerCacheContext({
      lazyEdges: this._lazyEdges,
      parsers: this._parsers,
      scanners: this._scanners,
      urlLoader: this._loader,
      urlResolver: this._resolver
    });
    copy._telemetryTracker = this._telemetryTracker;
    copy._cache = cache;
    copy._generation = this._generation + 1;
    return copy;
  }

  private async _scanLocal(resolvedUrl: string, contents?: string):
      Promise<ScannedDocument> {
    return this._cache.scannedDocumentPromises.getOrCompute(
        resolvedUrl, async() => {
          const parsedDoc = await this._parse(resolvedUrl, contents);
          const scannedDocument = await this._scanDocument(parsedDoc);

          // Find all non-lazy imports
          const imports = scannedDocument.getNestedFeatures().filter(
              (e) => e instanceof ScannedImport &&
                  e.type !== 'lazy-html-import') as ScannedImport[];

          // Update dependency graph
          const importUrls = imports.map((i) => this._resolveUrl(i.url));
          this._cache.dependencyGraph.addDocument(resolvedUrl, importUrls);

          return scannedDocument;
        });
  }

  /**
   * Scan a toplevel document and all of its transitive dependencies.
   */
  private async _scan(resolvedUrl: string, contents?: string):
      Promise<ScannedDocument> {
    return this._cache.dependenciesScannedPromises.getOrCompute(
        resolvedUrl, async() => {
          const scannedDocument = await this._scanLocal(resolvedUrl, contents);

          // Find all non-lazy imports
          const imports = scannedDocument.getNestedFeatures().filter(
              (e) => e instanceof ScannedImport &&
                  e.type !== 'lazy-html-import') as ScannedImport[];

          // Scan imports
          for (const scannedImport of imports) {
            const importUrl = this._resolveUrl(scannedImport.url);
            (async() => {
              try {
                return await this._scan(importUrl);
              } catch (error) {
                if (error instanceof NoKnownParserError) {
                  // We probably don't want to fail when importing something
                  // that we don't know about here.
                }
                error = error || '';
                // TODO(rictic): move this to the resolve phase, it will be
                // improperly cached as it is.
                scannedDocument.warnings.push({
                  code: 'could-not-load',
                  message: `Unable to load import: ${error.message || error}`,
                  sourceRange:
                      (scannedImport.urlSourceRange ||
                       scannedImport.sourceRange)!,
                  severity: Severity.ERROR
                });
              }
            })();
          }
          await this._cache.dependencyGraph.whenReady(resolvedUrl);
          return scannedDocument;
        });
  }

  /**
   * Scans a ParsedDocument.
   */
  private async _scanDocument(
      document: ParsedDocument<any, any>,
      maybeAttachedComment?: string): Promise<ScannedDocument> {
    const warnings: Warning[] = [];
    const scannedFeatures = await this._getScannedFeatures(document);
    // If there's an HTML comment that applies to this document then we assume
    // that it applies to the first feature.
    const firstScannedFeature = scannedFeatures[0];
    if (firstScannedFeature && firstScannedFeature instanceof ScannedElement) {
      firstScannedFeature.applyHtmlComment(maybeAttachedComment);
    }

    const scannedDocument =
        new ScannedDocument(document, scannedFeatures, warnings);

    if (!scannedDocument.isInline) {
      if (this._cache.scannedDocuments.has(scannedDocument.url)) {
        throw new Error(
            'Scanned document already in cache. This should never happen.');
      }
      this._cache.scannedDocuments.set(scannedDocument.url, scannedDocument);
    }
    await this._scanInlineDocuments(scannedDocument);
    return scannedDocument;
  }

  private async _getScannedFeatures(document: ParsedDocument<any, any>):
      Promise<ScannedFeature[]> {
    const scanners = this._scanners.get(document.type);
    if (scanners) {
      return scan(document, scanners);
    }
    return [];
  }

  private async _scanInlineDocuments(containingDocument: ScannedDocument) {
    for (const feature of containingDocument.features) {
      if (!(feature instanceof ScannedInlineDocument)) {
        continue;
      }
      const locationOffset: LocationOffset = {
        line: feature.locationOffset.line,
        col: feature.locationOffset.col,
        filename: containingDocument.url
      };
      try {
        const parsedDoc = this._parseContents(
            feature.type,
            feature.contents,
            containingDocument.url,
            {locationOffset, astNode: feature.astNode});
        const scannedDoc =
            await this._scanDocument(parsedDoc, feature.attachedComment);

        feature.scannedDocument = scannedDoc;
      } catch (err) {
        if (err instanceof WarningCarryingException) {
          containingDocument.warnings.push(err.warning);
          continue;
        }
        throw err;
      }
    }
  }

  /**
   * Loads the content at the provided resolved URL.
   *
   * Currently does no caching. If the provided contents are given then they
   * are used instead of hitting the UrlLoader (e.g. when you have in-memory
   * contents that should override disk).
   */
  async load(resolvedUrl: string, providedContents?: string) {
    if (!this._loader.canLoad(resolvedUrl)) {
      throw new Error(`Can't load URL: ${resolvedUrl}`);
    }
    return providedContents == null ? await this._loader.load(resolvedUrl) :
                                      providedContents;
  }

  /**
   * Caching + loading wrapper around _parseContents.
   */
  private async _parse(resolvedUrl: string, providedContents?: string):
      Promise<ParsedDocument<any, any>> {
    return this._cache.parsedDocumentPromises.getOrCompute(
        resolvedUrl, async() => {
          const content = await this.load(resolvedUrl, providedContents);
          const extension = path.extname(resolvedUrl).substring(1);

          const doneTiming =
              this._telemetryTracker.start('parse', 'resolvedUrl');
          const parsedDoc =
              this._parseContents(extension, content, resolvedUrl);
          doneTiming();
          return parsedDoc;
        });
  }

  /**
   * Parse the given string into the Abstract Syntax Tree (AST) corresponding
   * to its type.
   */
  private _parseContents(
      type: string, contents: string, url: string,
      inlineInfo?: InlineDocInfo<any>): ParsedDocument<any, any> {
    const parser = this._parsers.get(type);
    if (parser == null) {
      throw new NoKnownParserError(`No parser for for file type ${type}`);
    }
    try {
      return parser.parse(contents, url, inlineInfo);
    } catch (error) {
      if (error instanceof WarningCarryingException) {
        throw error;
      }
      throw new Error(`Error parsing ${url}:\n ${error.stack}`);
    }
  }

  /**
   * Resolves a URL with this Analyzer's `UrlResolver` if it has one, otherwise
   * returns the given URL.
   */
  private _resolveUrl(url: string): string {
    return this._resolver && this._resolver.canResolve(url) ?
        this._resolver.resolve(url) :
        url;
  }
}
