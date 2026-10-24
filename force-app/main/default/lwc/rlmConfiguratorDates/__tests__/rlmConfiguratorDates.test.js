import { createElement } from "lwc";
import RlmConfiguratorDates from "c/rlmConfiguratorDates";
import { publish } from "lightning/messageService";
import { getRecord } from "lightning/uiRecordApi";

jest.mock(
  "@salesforce/messageChannel/lightning__productConfigurator_notification",
  () => ({ default: "lightning__productConfigurator_notification" }),
  { virtual: true }
);

const ITEMS = [
  {
    productKey: ["root"],
    StartDate: "2026-01-01",
    EndDate: "2026-12-31",
    SubscriptionTerm: 1,
    SubscriptionTermUnit: "Annual"
  },
  { productKey: ["root", "child"], StartDate: "2020-01-01" }
];

const flush = () => Promise.resolve();

function build(props = {}) {
  const element = createElement("c-rlm-configurator-dates", {
    is: RlmConfiguratorDates
  });
  Object.assign(element, {
    transactionLineId: "root",
    salesTransactionItems: ITEMS,
    contextMetadata: JSON.stringify({
      StartDate: { attributeId: "START_ATTR", queryAttribute: "StartDate" },
      EndDate: { attributeId: "END_ATTR", queryAttribute: "EndDate" }
    }),
    ...props
  });
  document.body.appendChild(element);
  return element;
}

function field(element, name) {
  return [...element.shadowRoot.querySelectorAll("lightning-input")].find(
    (el) => el.name === name
  );
}

function changeTerm(element, value) {
  field(element, "term").dispatchEvent(
    new CustomEvent("change", { detail: { value } })
  );
}

describe("c-rlm-configurator-dates", () => {
  beforeEach(() => {
    jest.useFakeTimers();
    publish.mockClear?.();
  });
  afterEach(() => {
    while (document.body.firstChild) {
      document.body.removeChild(document.body.firstChild);
    }
    jest.useRealTimers();
  });

  it("seeds inputs from the root item", async () => {
    const el = build();
    await flush();
    expect(field(el, "start").value).toBe("2026-01-01");
    expect(field(el, "end").value).toBe("2026-12-31");
    expect(field(el, "term").value).toBe(1);
    expect(field(el, "unit").value).toBe("Annual");
  });

  it("makes Start, End and Term editable and Unit read-only", async () => {
    const el = build();
    await flush();
    expect(field(el, "start").disabled).toBe(false);
    expect(field(el, "end").disabled).toBe(false);
    expect(field(el, "term").disabled).toBe(false);
    expect(field(el, "unit").readOnly).toBe(true);
    expect(field(el, "unit").disabled).toBeFalsy();
  });

  const changeDate = (el, name, value) =>
    field(el, name).dispatchEvent(
      new CustomEvent("change", { detail: { value } })
    );

  it("publishes an End edit as a ContextFields event", async () => {
    const el = build();
    await flush();
    changeDate(el, "end", "2027-06-30");
    jest.runAllTimers();
    expect(publish).toHaveBeenCalledTimes(1);
    expect(publish.mock.calls[0][2]).toEqual({
      action: "valueChanged",
      data: [
        {
          key: ["root"],
          field: "ContextFields",
          attributeId: "END_ATTR",
          value: "2027-06-30T00:00:00.000Z",
          fieldName: "EndDate"
        }
      ]
    });
  });

  it("publishes Start and End edits in one event", async () => {
    const el = build();
    await flush();
    changeDate(el, "start", "2026-02-01");
    changeDate(el, "end", "2027-06-30");
    jest.runAllTimers();
    expect(publish).toHaveBeenCalledTimes(1);
    expect(
      publish.mock.calls[0][2].data.map((d) => [d.fieldName, d.attributeId])
    ).toEqual([
      ["StartDate", "START_ATTR"],
      ["EndDate", "END_ATTR"]
    ]);
  });

  it("does not publish a date edit without an attribute id", async () => {
    const el = build({ contextMetadata: undefined });
    await flush();
    changeDate(el, "end", "2027-06-30");
    jest.runAllTimers();
    await flush();
    expect(publish).not.toHaveBeenCalled();
    expect(el.shadowRoot.querySelector("[role=alert]")).not.toBeNull();
  });

  it("discovers the ids from an object and by queryAttribute", async () => {
    const el = build({
      contextMetadata: {
        Renamed: {
          attributeId: "E2",
          sObjectDomain: "QuoteLineItem",
          queryAttribute: "EndDate"
        }
      }
    });
    await flush();
    changeDate(el, "end", "2027-06-30");
    jest.runAllTimers();
    expect(publish.mock.calls[0][2].data[0].attributeId).toBe("E2");
  });

  it("blocks publish when End is before Start", async () => {
    const el = build();
    await flush();
    changeDate(el, "end", "2025-12-31");
    jest.runAllTimers();
    await flush();
    expect(publish).not.toHaveBeenCalled();
    expect(el.shadowRoot.querySelector("[role=alert]").textContent).toContain(
      "End Date"
    );
  });

  it("picks the root even when children come first in the array", async () => {
    const el = build({ salesTransactionItems: [...ITEMS].reverse() });
    await flush();
    expect(field(el, "term").value).toBe(1);
    changeTerm(el, "2");
    jest.runAllTimers();
    expect(publish.mock.calls[0][2].data[0].key).toEqual(["root"]);
  });

  it("publishes SubscriptionTerm and EndDate together on a term edit, debounced", async () => {
    const el = build();
    await flush();
    changeTerm(el, "2");
    expect(publish).not.toHaveBeenCalled();
    jest.runAllTimers();
    expect(publish).toHaveBeenCalledTimes(1);
    expect(publish.mock.calls[0][2]).toEqual({
      action: "valueChanged",
      data: [
        {
          key: ["root"],
          values: [
            { field: "SubscriptionTerm", value: 2 },
            { field: "EndDate", value: "2027-12-31" }
          ]
        }
      ]
    });
  });

  it("omits EndDate when it cannot be computed", async () => {
    const el = build({
      salesTransactionItems: [
        {
          productKey: ["root"],
          StartDate: null,
          EndDate: null,
          SubscriptionTerm: 1,
          SubscriptionTermUnit: "Annual"
        }
      ]
    });
    await flush();
    changeTerm(el, "2");
    jest.runAllTimers();
    expect(publish.mock.calls[0][2].data[0].values).toEqual([
      { field: "SubscriptionTerm", value: 2 }
    ]);
  });

  it("previews End as Start + term x unit - 1 day", async () => {
    const el = build();
    await flush();
    changeTerm(el, "3");
    await flush();
    expect(field(el, "end").value).toBe("2028-12-31");
  });

  it("previews End by month and clamps short months", async () => {
    const el = build({
      salesTransactionItems: [
        {
          productKey: ["root"],
          StartDate: "2026-01-31",
          EndDate: "2026-02-27",
          SubscriptionTerm: 1,
          SubscriptionTermUnit: "Monthly"
        }
      ]
    });
    await flush();
    changeTerm(el, "2");
    await flush();
    expect(field(el, "end").value).toBe("2026-03-30");
  });

  it("does not republish an unchanged term", async () => {
    const el = build();
    await flush();
    changeTerm(el, "1");
    jest.runAllTimers();
    expect(publish).not.toHaveBeenCalled();
  });

  it("blocks publish when the term is below 1", async () => {
    const el = build();
    await flush();
    changeTerm(el, "0");
    await flush();
    jest.runAllTimers();
    expect(publish).not.toHaveBeenCalled();
    expect(el.shadowRoot.querySelector("[role=alert]")).not.toBeNull();
  });

  it("disables the term input while the Data Manager is busy", async () => {
    const el = build({ isApiInProgress: true });
    await flush();
    expect(field(el, "term").disabled).toBe(true);
  });

  const applyButton = (el) => el.shadowRoot.querySelector("lightning-button");

  it("applies Start to every option and End to term-defined options only", async () => {
    const el = build({
      salesTransactionItems: [
        ITEMS[0],
        { productKey: ["root", "a"], SellingModelType: "OneTime" },
        { productKey: ["root", "b"], SellingModelType: "Evergreen" },
        { productKey: ["root", "c"], SellingModelType: "TermDefined" }
      ]
    });
    await flush();
    applyButton(el).click();
    expect(publish).toHaveBeenCalledTimes(1);
    expect(
      publish.mock.calls[0][2].data.map((d) => [
        d.key[1],
        d.fieldName,
        d.attributeId,
        d.value
      ])
    ).toEqual([
      ["a", "StartDate", "START_ATTR", "2026-01-01T00:00:00.000Z"],
      ["b", "StartDate", "START_ATTR", "2026-01-01T00:00:00.000Z"],
      ["c", "StartDate", "START_ATTR", "2026-01-01T00:00:00.000Z"],
      ["c", "EndDate", "END_ATTR", "2026-12-31T00:00:00.000Z"]
    ]);
  });

  it("skips option dates that already match", async () => {
    const el = build({
      salesTransactionItems: [
        ITEMS[0],
        {
          productKey: ["root", "c"],
          SellingModelType: "TermDefined",
          StartDate: "2026-01-01T00:00:00.000Z",
          EndDate: "2026-12-31T00:00:00.000Z"
        }
      ]
    });
    await flush();
    applyButton(el).click();
    expect(publish).not.toHaveBeenCalled();
  });

  it("disables Apply when there are no options", async () => {
    const el = build({ salesTransactionItems: [ITEMS[0]] });
    await flush();
    expect(applyButton(el).disabled).toBe(true);
  });

  it("falls back to the item's PricingTermUnit, then the selling model", async () => {
    const el = build({
      salesTransactionItems: [
        { productKey: ["root"], PricingTermUnit: "Annual" }
      ]
    });
    await flush();
    expect(field(el, "unit").value).toBe("Annual");

    const bare = build({
      salesTransactionItems: [
        { productKey: ["root"], ProductSellingModel: "0jP000000000001" }
      ]
    });
    await flush();
    getRecord.emit({ fields: { PricingTermUnit: { value: "Months" } } });
    await flush();
    expect(field(bare, "unit").value).toBe("Months");
  });

  it("shows only Start and applies Start only for a non-term-defined root", async () => {
    const el = build({
      salesTransactionItems: [
        {
          productKey: ["root"],
          SellingModelType: "Evergreen",
          StartDate: "2026-10-24"
        },
        { productKey: ["root", "c"], SellingModelType: "TermDefined" }
      ]
    });
    await flush();
    expect(field(el, "start").value).toBe("2026-10-24");
    expect(field(el, "end")).toBeUndefined();
    expect(field(el, "term")).toBeUndefined();
    expect(field(el, "unit")).toBeUndefined();
    const button = el.shadowRoot.querySelector("lightning-button");
    expect(button.disabled).toBe(false);
    button.click();
    expect(
      publish.mock.calls[0][2].data.map((d) => [d.key[1], d.fieldName])
    ).toEqual([["c", "StartDate"]]);
  });

  it("publishes a Start edit on an evergreen root without a term", async () => {
    const el = build({
      salesTransactionItems: [
        {
          productKey: ["root"],
          SellingModelType: "Evergreen",
          StartDate: "2026-10-24"
        }
      ]
    });
    await flush();
    changeDate(el, "start", "2026-11-01");
    jest.runAllTimers();
    expect(publish.mock.calls[0][2].data[0].fieldName).toBe("StartDate");
  });
});
