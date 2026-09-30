import com.scene7.api.webserviceclient.*;

// Discovery: authenticate and list Scene7 assets in a folder (member handles).
// args: server, user, password, companyHandle, folder
public class IPSExplore {
    public static void main(String[] args) throws Exception {
        String server = args[0], user = args[1], pass = args[2];
        String companyHandle = args[3], folder = args[4];

        IpsApiServiceStub stub = new IpsApiServiceStub(server.endsWith("/") ? server : server + "/");

        AuthHeader auth = new AuthHeader();
        auth.setUser(user);
        auth.setPassword(pass);
        auth.setAppName("fanout-demo");
        auth.setAppVersion("1.0.0");

        SearchAssetsParam p = new SearchAssetsParam();
        p.setCompanyHandle(companyHandle);
        p.setFolder(folder);
        p.setIncludeSubfolders(true);
        p.setRecordsPerPage(100);
        p.setResultsPage(1);

        SearchAssetsReturn r = stub.searchAssets(p, auth);
        System.out.println("TOTAL_ROWS=" + r.getTotalRows());
        AssetArray arr = r.getAssetArray();
        if (arr == null || arr.getItems() == null) { System.out.println("(no assets)"); return; }
        for (Asset a : arr.getItems()) {
            System.out.println("ASSET | type=" + a.getType() + " subType=" + a.getSubType()
                + " | name=" + a.getName()
                + " | handle=" + a.getAssetHandle()
                + " | folder=" + a.getFolder()
                + " | folderHandle=" + a.getFolderHandle()
                + " | ready=" + a.getReadyForPublish());
        }
    }
}
