import { LightningElement, api, wire } from "lwc";
import { MessageContext, publish } from "lightning/messageService";
import { getRecord } from "lightning/uiRecordApi";
import CONFIGR_CHANNEL from "@salesforce/messageChannel/lightning__productConfigurator_notification";

const VALUE_CHANGED_ACTION = "valueChanged";
const DEFAULT_START_FIELD = "StartDate";
const DEFAULT_END_FIELD = "EndDate";
const CONTEXT_FIELDS = "ContextFields";
const TERM_DEFINED = "TermDefined";
const TERM_FIELD = "SubscriptionTerm";
const UNIT_FIELD = "SubscriptionTermUnit";
const PUBLISH_DEBOUNCE_MS = 400;
// Months per term unit, used to preview End = Start + term - 1 day.
const UNIT_MONTHS = { Months: 1, Monthly: 1, Quarterly: 3, Annual: 12 };

/**
 * Configurator Dates Flow Screen Component
 * @description
 * - Placed on the Product Configurator screen next to the Data Manager
 * - Start Date, End Date and Subscription Term of the root product are
 *   editable; Term Unit is read-only
 * - Start and End are published as `ContextFields` events (the option-card
 *   shape), which the Data Manager persists to the line. Plain line-field
 *   `values` writes of StartDate/EndDate are dropped, so they are not used.
 *   The event needs the ContextAttribute id of each date field.
 * - A term edit is published with the multi-value syntax
 *   { key: [lineKey], values: [{ field, value }] }; End previews locally as
 *   Start + term x unit - 1 day and rides along with the term
 * - "Apply dates to options" copies the root Start to every option line and the
 *   root End to term-defined options only (one-time options reject an End,
 *   evergreen ones have none), with the same ContextFields events keyed by
 *   each option's productKey
 * - Seeds its inputs from the root item in `salesTransactionItems`
 */
export default class RlmConfiguratorDates extends LightningElement {
  @api transactionLineId;
  @api isApiInProgress = false;
  @api isConfiguratorDisabled = false;

  /** Override the line field names if the org maps dates to custom fields. */
  @api startDateField = DEFAULT_START_FIELD;
  @api endDateField = DEFAULT_END_FIELD;

  /**
   * Data Manager contextMetadata (JSON string or object). The ContextAttribute
   * ids of the Start and End Date fields, which differ per org, come from it.
   */
  @api
  get contextMetadata() {
    return this._contextMetadata;
  }
  set contextMetadata(value) {
    this._contextMetadata = value;
    this._discovered = this.discoverAttributeIds(value);
  }

  _contextMetadata;
  _discovered = {};
  _salesTransactionItems = [];
  _state = {};
  _lastPublishedTerm = null;
  _modelUnit = null;
  _modelType = null;
  _termDirty = false;
  _dirtyDates = new Set();
  _publishTimer;
  errorMessage = null;

  @wire(MessageContext)
  messageContext;

  // A net-new line has no saved unit yet; the selling model carries it.
  @wire(getRecord, {
    recordId: "$sellingModelId",
    fields: [
      "ProductSellingModel.PricingTermUnit",
      "ProductSellingModel.SellingModelType"
    ]
  })
  wiredSellingModel({ data }) {
    this._modelUnit = data?.fields?.PricingTermUnit?.value || null;
    this._modelType = data?.fields?.SellingModelType?.value || null;
  }

  @api
  get salesTransactionItems() {
    return this._salesTransactionItems;
  }
  set salesTransactionItems(value) {
    this._salesTransactionItems = Array.isArray(value) ? value : [];
    this.seedFromState();
  }

  disconnectedCallback() {
    clearTimeout(this._publishTimer);
  }

  get startDate() {
    return this._state.start ?? null;
  }

  get endDate() {
    return this._state.end ?? null;
  }

  get term() {
    return this._state.term ?? null;
  }

  get termUnit() {
    return this._state.unit ?? this._modelUnit ?? null;
  }

  /**
   * Only term-defined roots take an End, a term and a unit; one-time and
   * evergreen roots take a Start only. An unknown type is treated as
   * term-defined.
   */
  get isTermDefined() {
    const type = this.rootItem?.SellingModelType || this._modelType;
    return !type || type === TERM_DEFINED;
  }

  get sellingModelId() {
    return this.rootItem?.ProductSellingModel || undefined;
  }

  get isDisabled() {
    return (
      this.isApiInProgress === true || this.isConfiguratorDisabled === true
    );
  }

  /** Every line below the root: the product options at any depth. */
  get optionItems() {
    const rootLength = this.rootKey.length;
    return this._salesTransactionItems.filter(
      (item) =>
        Array.isArray(item.productKey) && item.productKey.length > rootLength
    );
  }

  get isApplyDisabled() {
    const { start, end } = this._state;
    return (
      this.isDisabled ||
      Boolean(this._publishTimer) ||
      Boolean(this.errorMessage) ||
      !start ||
      (this.isTermDefined && !end) ||
      !this.optionItems.length
    );
  }

  get startField() {
    return this.startDateField || DEFAULT_START_FIELD;
  }

  get endField() {
    return this.endDateField || DEFAULT_END_FIELD;
  }

  /**
   * The root line is the shortest key (children extend the root's key). Ties
   * prefer the item whose own id is transactionLineId. Matching on "key
   * contains transactionLineId" would also match every child.
   */
  get rootItem() {
    const items = this._salesTransactionItems.filter(
      (item) => Array.isArray(item.productKey) && item.productKey.length
    );
    const isOwn = (item) =>
      item.productKey[item.productKey.length - 1] === this.transactionLineId;
    return items.reduce((root, item) => {
      if (!root || item.productKey.length < root.productKey.length) {
        return item;
      }
      if (item.productKey.length === root.productKey.length && isOwn(item)) {
        return item;
      }
      return root;
    }, null);
  }

  get rootKey() {
    return this.rootItem?.productKey || [this.transactionLineId];
  }

  get resolvedStartAttributeId() {
    return this._discovered.start || null;
  }

  get resolvedEndAttributeId() {
    return this._discovered.end || null;
  }

  /**
   * contextMetadata is keyed by context attribute name, each entry carrying
   * `attributeId` and `queryAttribute` (the QuoteLineItem field). Look the
   * date fields up by attribute name, then by queryAttribute.
   */
  discoverAttributeIds(raw) {
    let meta = raw;
    if (typeof raw === "string") {
      try {
        meta = JSON.parse(raw);
      } catch (e) {
        return {};
      }
    }
    if (!meta || typeof meta !== "object") {
      return {};
    }
    const idFor = (field) =>
      meta[field]?.attributeId ||
      Object.values(meta).find(
        (entry) =>
          entry?.sObjectDomain === "QuoteLineItem" &&
          entry.queryAttribute === field
      )?.attributeId;
    return { start: idFor(this.startField), end: idFor(this.endField) };
  }

  seedFromState() {
    const root = this.rootItem;
    if (!root) {
      return;
    }
    // Don't overwrite an edit that is still waiting to be published.
    if (this._publishTimer) {
      return;
    }
    this._state = {
      start: this.toDateInput(root[this.startField]),
      end: this.toDateInput(root[this.endField]),
      term: root[TERM_FIELD] ?? null,
      unit: root[UNIT_FIELD] || root.PricingTermUnit || null
    };
    this._lastPublishedTerm = this._state.term;
  }

  toDateInput(value) {
    return value ? String(value).slice(0, 10) : null;
  }

  handleTermChange(event) {
    const parsed = parseInt(event.detail.value, 10);
    const term = Number.isNaN(parsed) ? null : parsed;
    this._state = {
      ...this._state,
      term,
      end:
        this.endFor(this._state.start, term, this.termUnit) ?? this._state.end
    };
    this._termDirty = true;
    this.queuePublish();
  }

  /** Start + term units - 1 day as YYYY-MM-DD, or null if not computable. */
  endFor(start, term, unit) {
    const unitMonths = UNIT_MONTHS[unit];
    if (!start || !unitMonths || !(term >= 1)) {
      return null;
    }
    const [y, m, d] = start.split("-").map(Number);
    const target = new Date(Date.UTC(y, m - 1 + term * unitMonths, 1));
    const lastDay = new Date(
      Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)
    ).getUTCDate();
    target.setUTCDate(Math.min(d, lastDay) - 1);
    return target.toISOString().slice(0, 10);
  }

  queuePublish() {
    const { term, start, end } = this._state;
    this.errorMessage = null;
    if (this.isTermDefined && (term === null || term < 1)) {
      this.errorMessage = "Term must be at least 1.";
    } else if (start && end && end < start) {
      this.errorMessage = "End Date must be on or after Start Date.";
    }
    clearTimeout(this._publishTimer);
    if (this.errorMessage) {
      this._publishTimer = null;
      return;
    }
    this._publishTimer = setTimeout(() => {
      this._publishTimer = null;
      this.publishTerm();
    }, PUBLISH_DEBOUNCE_MS);
  }

  handleDateChange(event) {
    const key = event.target.name === "start" ? "start" : "end";
    this._state = { ...this._state, [key]: event.detail.value || null };
    this._dirtyDates.add(key);
    this.queuePublish();
  }

  /**
   * Copies the root Start to every option and the root End to the term-defined
   * options, skipping values that already match.
   */
  handleApplyToOptions() {
    const { start, end } = this._state;
    const startId = this.resolvedStartAttributeId;
    const endId = this.resolvedEndAttributeId;
    if (!startId || (this.isTermDefined && !endId)) {
      this.errorMessage =
        "Bind the Data Manager contextMetadata to save date edits.";
      return;
    }
    const entry = (item, attributeId, fieldName, date) => ({
      key: item.productKey,
      field: CONTEXT_FIELDS,
      attributeId,
      value: `${date}T00:00:00.000Z`,
      fieldName
    });
    const data = this.optionItems.flatMap((item) => [
      ...(this.toDateInput(item[this.startField]) === start
        ? []
        : [entry(item, startId, this.startField, start)]),
      // One-time options reject an EndDate and evergreen ones have none.
      ...(!this.isTermDefined ||
      item.SellingModelType !== TERM_DEFINED ||
      this.toDateInput(item[this.endField]) === end
        ? []
        : [entry(item, endId, this.endField, end)])
    ]);
    if (!data.length) {
      return;
    }
    try {
      publish(this.messageContext, CONFIGR_CHANNEL, {
        action: VALUE_CHANGED_ACTION,
        data
      });
    } catch (error) {
      this.errorMessage = `Apply to options error: ${error.message}`;
    }
  }

  publishTerm() {
    const { term, start } = this._state;
    const unit = this.termUnit;
    try {
      if (this._termDirty && term !== this._lastPublishedTerm) {
        const values = [{ field: TERM_FIELD, value: term }];
        const end = this.endFor(start, term, unit);
        if (end) {
          values.push({ field: this.endField, value: end });
        }
        publish(this.messageContext, CONFIGR_CHANNEL, {
          action: VALUE_CHANGED_ACTION,
          data: [{ key: this.rootKey, values }]
        });
        this._lastPublishedTerm = term;
      }
      const data = [...this._dirtyDates]
        .filter((key) => this._state[key])
        .map((key) => ({
          key: this.rootKey,
          field: CONTEXT_FIELDS,
          attributeId:
            key === "start"
              ? this.resolvedStartAttributeId
              : this.resolvedEndAttributeId,
          value: `${this._state[key]}T00:00:00.000Z`,
          fieldName: key === "start" ? this.startField : this.endField
        }));
      if (data.some((entry) => !entry.attributeId)) {
        this._dirtyDates.clear();
        this.errorMessage =
          "Bind the Data Manager contextMetadata to save date edits.";
        return;
      }
      this._termDirty = false;
      this._dirtyDates.clear();
      if (data.length) {
        publish(this.messageContext, CONFIGR_CHANNEL, {
          action: VALUE_CHANGED_ACTION,
          data
        });
      }
    } catch (error) {
      this.errorMessage = `Term update error: ${error.message}`;
    }
  }
}
