*** Settings ***
Documentation       End-to-end smoke scenarios driven through a real browser and a
...                 real server: seeding a game shows the default fleet, and buying
...                 an asset grows the fleet while spending credit.
...                 Run with:  npm run test:robot   (or:  robot test/robot)

Library             Browser
Library             Process
Library             OperatingSystem
Library             Collections

Suite Setup         Start Server And Browser
Suite Teardown      Close Browser And Stop Server
Test Setup          Open A Freshly Seeded Game


*** Variables ***
${PORT}             3781
${BASE_URL}         http://localhost:${PORT}
${HEADLESS}         ${True}
# The nine vehicles every fresh game seeds: 1 light vehicle, 4 shovels, 4 trucks.
@{DEFAULT_FLEET}    LV01    HEX01    HEX02    HEX03    HEX04    OHT01    OHT02    OHT03    OHT04


*** Test Cases ***
Default Fleet Is Displayed After Seeding A Game
    [Documentation]    Creating a game seeds the authoritative world; the Assets
    ...                panel then lists exactly the nine default vehicles.
    Open Assets Panel
    Get Text            id=al-count    ==    9
    Get Element Count    .al-row       ==    9
    Fleet List Shows All Default Assets

Buying An Asset Grows The Fleet And Spends Credit
    [Documentation]    Buying the $25,000 Light Utility Vehicle drops the balance
    ...                from $100,000 to $75,000 and adds a tenth vehicle.
    Open Shop
    Buy The Asset    LV
    Get Text            id=credit       ==    $75,000      # $100,000 − $25,000
    Close Shop
    Open Assets Panel
    Get Text            id=al-count    ==    10
    Get Element Count    .al-row       ==    10


*** Keywords ***
Start Server And Browser
    ${root}=    Normalize Path    ${CURDIR}/../..
    ${results}=    Normalize Path    ${OUTPUT DIR}
    # Real server: isolated DB in the results dir, anti-abuse limits off for the test.
    ${proc}=    Start Process    node    server.js
    ...    env:PORT=${PORT}    env:DATA_DIR=${results}    env:TEST_MODE=1
    ...    cwd=${root}    stdout=${results}/server.log    stderr=STDOUT
    Set Suite Variable    ${SERVER}    ${proc}
    Wait Until Keyword Succeeds    40x    0.5s    Server Is Up
    New Browser    chromium    headless=${HEADLESS}
    New Context    viewport={'width': 1366, 'height': 768}

Server Is Up
    # Arrow functions would carry a '=' that Process reads as a named arg, so use
    # classic function syntax here.
    ${r}=    Run Process    node    -e
    ...    fetch('${BASE_URL}/').then(function(x){process.exit(x.ok?0:1)}).catch(function(){process.exit(1)})
    Should Be Equal As Integers    ${r.rc}    0

Close Browser And Stop Server
    Run Keyword And Ignore Error    Close Browser    ALL
    Run Keyword And Ignore Error    Terminate Process    ${SERVER}    kill=${True}

Open A Freshly Seeded Game
    New Page                    ${BASE_URL}/
    Click                       id=lobby-create
    Wait For Elements State     id=lobby       hidden     timeout=10s
    Wait For Elements State     css=.topbar    visible
    # Wait for the authoritative state to land (starting credit) so the UI is
    # fully populated and stable before we interact with it.
    Get Text                    id=credit      ==    $100,000

Open Assets Panel
    Click                       id=assets-btn
    Wait For Elements State     id=asset-list           visible
    Wait For Elements State     .al-row >> nth=0         visible    timeout=10s

Open Shop
    Click                       id=shop-btn
    Wait For Elements State     id=shop                       visible
    Wait For Elements State     .shop-buy >> nth=0            visible    timeout=10s

Buy The Asset
    [Arguments]    ${id}
    # Fire the buy button's real click handler (net.buy → server → broadcast), so
    # the full path is exercised. We dispatch via JS rather than a hit-test click
    # because the button sits in a centered modal backdrop Playwright's hit-test
    # can flag. The function does its own querySelector, so the only Robot arg is
    # the bare ${id} — no selector containing '=' (which Robot mis-reads as named).
    ${fn}=    Set Variable    () => document.querySelector('.shop-buy[data-id="${id}"]').click()
    Evaluate JavaScript    ${None}    ${fn}

Close Shop
    ${fn}=    Set Variable    () => document.querySelector('#shop .shop-close').click()
    Evaluate JavaScript         ${None}    ${fn}
    Wait For Elements State     id=shop    hidden    timeout=10s

Fleet List Shows All Default Assets
    ${body}=    Get Text    id=al-body
    FOR    ${label}    IN    @{DEFAULT_FLEET}
        Should Contain    ${body}    ${label}    msg=Fleet list is missing ${label}
    END
