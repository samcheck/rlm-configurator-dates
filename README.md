# RLM Configurator Dates

`RLM Configurator Dates` (`c:rlmConfiguratorDates`) is a Product Configurator
Flow Screen component for Salesforce Revenue Lifecycle Management. It edits the
start date, end date and subscription term of the product being configured (the
root line) and can copy the dates to its options.

It is a single Lightning Web Component in a standard Salesforce DX project, so
it deploys on its own. You add it to a copy of your configurator flow by hand.

## Requirements

- An org with the Product Configurator and the Data Manager flow component
  (`runtime_industries_cfg:dataManager`)
- Salesforce CLI (`sf`)
- Node.js, only to run the Jest tests

## Deploy

```bash
sf project deploy start --source-dir force-app --target-org <alias>
```

## Develop

```bash
npm install
npm test
npm run prettier
```

## Flow Setup

Clone the configurator flow, then place `RLM Configurator Dates` on the
configurator screen after the Data Manager component.

| Component Property                 | Flow Value                                                                             |
| ---------------------------------- | -------------------------------------------------------------------------------------- |
| `transactionLineId` (required)     | Data Manager `transactionLineId`                                                       |
| `salesTransactionItems` (required) | Data Manager `salesTransactionItems`                                                   |
| `isApiInProgress`                  | Data Manager `isApiInProgress`                                                         |
| `isConfiguratorDisabled`           | Data Manager `isConfiguratorDisabled`                                                  |
| `contextMetadata` (required)       | Data Manager `contextMetadata`; the component discovers the date attribute ids from it |
| `startDateField`                   | Optional; defaults to `StartDate`                                                      |
| `endDateField`                     | Optional; defaults to `EndDate`                                                        |

### Attribute ids

The `ContextFields` event needs the ContextAttribute id of each date field, and
the ids differ per org. Bind `contextMetadata` and the component finds them: the
Data Manager output is an object keyed by context attribute name, each entry
carrying `attributeId` and `queryAttribute`:

```json
{
  "StartDate": {
    "dataType": "DATETIME",
    "attributeId": "<id>",
    "sObjectDomain": "QuoteLineItem",
    "queryAttribute": "StartDate",
    "label": "Start Date",
    "updateable": true
  }
}
```

It looks up `StartDate` / `EndDate` by key (or the configured field names), then
by `queryAttribute` on `QuoteLineItem`. Without `contextMetadata`
the component shows an error and does not publish date edits (term edits still
work). To look the ids up by
hand:

```bash
sf data query --target-org <sf_alias_or_username> -q \
  "SELECT Id, Title FROM ContextAttribute WHERE Title IN ('StartDate','EndDate') AND ContextNode.Title = 'SalesTransactionItem' AND ContextNode.ContextDefinitionVersion.ContextDefinition.DeveloperName = '<your context definition>'"
```

## How Each Field Is Saved

**Use `ContextFields` events for dates.** The Data Manager persists date edits
that arrive as a `ContextFields` event (the same shape the option cards send)
and drops dates sent as plain line-field `values`. That makes `ContextFields`
the reliable path for Start and End; the `values` form only works for the term.

| Field             | Published as                              | Persists |
| ----------------- | ----------------------------------------- | -------- |
| Start Date        | `ContextFields` event                     | Yes      |
| End Date          | `ContextFields` event                     | Yes      |
| Subscription Term | `values` event (with a derived `EndDate`) | Yes      |

`ContextFields` event (one `data` entry per changed date, both can share an
event):

```json
{
  "action": "valueChanged",
  "data": [
    {
      "key": ["<root key>"],
      "field": "ContextFields",
      "attributeId": "<ContextAttribute id>",
      "value": "2029-08-07T00:00:00.000Z",
      "fieldName": "EndDate"
    }
  ]
}
```

Term event:

```json
{
  "action": "valueChanged",
  "data": [
    {
      "key": ["<root key>"],
      "values": [
        { "field": "SubscriptionTerm", "value": 3 },
        { "field": "EndDate", "value": "2029-10-22" }
      ]
    }
  ]
}
```

## Live Findings

- Start, End and Subscription Term edits through these events all persist to
  the QuoteLineItem and show in the line editor and configurator.
- Writing `StartDate` / `EndDate` as `values` was ignored or reverted on
  refresh, even together with a changed term. The platform re-derived End as
  Start + term x unit - 1 day. Restating an unchanged term did not help.
- Unit (`SubscriptionTermUnit`) is not publishable and is read-only here.
- `TransientEndDate` is unsuitable: it is transient, hydrate-only, unmapped to
  the line, and cleared on refresh.
- Pricing procedures do not set dates or term. Term-defined proration reads
  Start, End, `SubscriptionTerm` and the pricing term unit, and
  `PricingTermCount` follows the dates (an End of 7/17/2029 from a 10/23/2026
  start gives 2.73 for a 3-year term).
- The context definition already maps `StartDate`, `EndDate` and
  `SubscriptionTerm` both ways; no context definition change is needed.

## Runtime Behavior

1. Seeds the inputs from the root item in `salesTransactionItems`. The root is
   the shortest `productKey`; ties prefer the item whose last key element is
   `transactionLineId`.
2. Start and End edits publish a debounced `ContextFields` event with only the
   changed dates. End must be on or after Start.
3. A term edit previews End locally as Start + term x unit - 1 day and publishes
   the term with that End.
4. **Apply dates to options** copies the root Start to every option line (any
   line below the root) and the root End to the **term-defined** options only.
   One-time options reject an `EndDate` ("You can't specify EndDate for
   one-time order products"), and evergreen options have no end, so both get
   Start only. It sends the same `ContextFields` events, keyed by each option's
   `productKey` and chosen by the item's `SellingModelType`, in one
   `valueChanged` event, and skips values that already match. The button is
   disabled while an edit is pending, the dates are invalid or empty, or the
   product has no options.
5. Term Unit reads the root's `SubscriptionTermUnit`, then `PricingTermUnit`, then the
   `PricingTermUnit` of its `ProductSellingModel` (read with `getRecord`), so a
   net-new line with no saved term still shows a unit. The Apply button sits in the
   card header.
6. Only a **term-defined** root shows End, Term and Unit. For a one-time or
   evergreen root (`SellingModelType` on the item, else the selling model) the
   card shows Start only, and Apply copies Start to the options without needing an
   End.
7. Inputs are disabled while the Data Manager is busy. Term Unit is read-only.

## Open Items

- Editing Start or End leaves the other date and the term as they are; whether
  they re-derive after a refresh was not exercised beyond the cases above.
